/* Actual TypeScript PCM functions with injected short reads and WAV failures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-pcm-integrity-'));
class File {
  constructor(...parts) { this.uri=path.join(...parts.map(p=>typeof p==='string'?p:p.uri)); }
  get exists(){return fs.existsSync(this.uri)}
  get size(){return this.exists?fs.statSync(this.uri).size:0}
  delete(){fs.unlinkSync(this.uri)}
  open(){const fd=fs.openSync(this.uri,'r');let offset=0;return {
    get size(){return fs.fstatSync(fd).size},get offset(){return offset},set offset(v){offset=v},
    readBytes(n){const b=Buffer.alloc(n);const count=fs.readSync(fd,b,0,n,offset);offset+=count;return new Uint8Array(b.buffer,b.byteOffset,count)},
    close(){fs.closeSync(fd)},
  }}
}
let mode='valid', lastOutput='';
let decodeFails=false, fallbackFails=false, primaryPath='', fallbackPath='', fallbackCalls=0;
function header(dataLength, rate=48000) {
  const b=Buffer.alloc(44);b.write('RIFF',0);b.writeUInt32LE(dataLength+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(dataLength,40);return b;
}
const native={pcmToWav:async(input,output,rate)=>{
  lastOutput=output;const pcm=fs.readFileSync(input);let wav=Buffer.concat([header(pcm.length,rate),pcm]);
  if(mode==='short') wav=wav.subarray(0,wav.length-2);
  if(mode==='wrong-length') {wav=Buffer.concat([header(pcm.length-2,rate),pcm.subarray(0,pcm.length-2)]);}
  if(mode==='bad-header') wav.write('NOPE',0);
  fs.writeFileSync(output,wav);
  if(mode==='throws') throw Error('simulated disk full');
  return {trimStartUs:0,trimEndUs:100,trimmed:false};
}, decodeToPCM:async(_input,output)=>{
  primaryPath=output;fs.writeFileSync(output,decodeFails?'partial':'decoded');
  if(decodeFails)throw Error('synthetic media decoder failure');
  return {sampleRate:48000};
}, extractWavAudio:async(_input,output)=>{
  fallbackCalls++;fallbackPath=output;fs.writeFileSync(output,fallbackFails?'partial fallback':'direct');
  if(fallbackFails)throw Error('synthetic direct WAV failure');
  return {sampleRate:44100};
}};
const filename=path.join(__dirname,'../src/scripts/formatHandler.ts');
const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(__dirname);
const stubs={'@/modules/AudioProcessorModule':native,'expo-file-system':{File,Paths:{cache:{uri:work}}},'expo-media-library':{},
  'react-native':{Platform:{OS:'android',Version:36}},'./analytics':{},'./silenceTrim':{},'./resampler':{}};
mod.require=function(request){return Object.hasOwn(stubs,request)?stubs[request]:Module.prototype.require.call(this,request)};
mod._compile(js,filename);
const {readPCMChunks,PCMtoArray,PCMtoWav,decodeToPCMFile}=mod.exports;
function synthetic(bytes, reported, maxRead, changeSizeAfterRead=false) {
  let closed=false,reads=0,pos=0;
  return {exists:true,size:reported,get closed(){return closed},open(){return {
    get size(){return changeSizeAfterRead&&reads?bytes.length:reported},get offset(){return pos},set offset(v){pos=v},
    readBytes(n){reads++;const part=bytes.slice(pos,pos+Math.min(n,maxRead));pos+=part.length;return part},
    close(){closed=true},
  }}};
}
(async()=>{
  const source=new File(work,'private-recording.wav');fs.writeFileSync(source.uri,'original');
  const dest=new File(work,'caller-owned.pcm');
  let result=await decodeToPCMFile(source,dest.uri);
  assert.equal(result.sampleRate,48000);assert.equal(result.file.uri,dest.uri);assert.equal(fallbackCalls,0);
  assert.equal(fs.readFileSync(dest.uri,'utf8'),'decoded');
  decodeFails=true;
  const oldWarn=console.warn, warnings=[];console.warn=(...args)=>warnings.push(args.map(String).join(' '));
  try {
    result=await decodeToPCMFile(source,dest.uri);
    assert.equal(result.sampleRate,44100);assert.equal(primaryPath,dest.uri);assert.equal(fallbackPath,dest.uri);
    assert.equal(fs.readFileSync(dest.uri,'utf8'),'direct');assert.equal(fs.readFileSync(source.uri,'utf8'),'original');
    result=await decodeToPCMFile(source);
    assert.equal(primaryPath,fallbackPath,'default fallback must reuse the first staged path');
    assert.equal(result.file.uri,primaryPath);assert.equal(fs.readFileSync(source.uri,'utf8'),'original');
    fallbackFails=true;
    await assert.rejects(()=>decodeToPCMFile(source,dest.uri),/synthetic direct WAV failure/);
    const notWav=new File(work,'other.mp3');fs.writeFileSync(notWav.uri,'original mp3');const callsBefore=fallbackCalls;
    await assert.rejects(()=>decodeToPCMFile(notWav,dest.uri),/synthetic media decoder failure/);
    assert.equal(fallbackCalls,callsBefore,'non-WAV failures never enter the WAV parser');
    assert.equal(fs.readFileSync(notWav.uri,'utf8'),'original mp3');
  } finally {console.warn=oldWarn;decodeFails=false;fallbackFails=false}
  assert.ok(warnings.length>=2 && warnings.every(line=>!line.includes(source.uri) && !line.includes('private-recording')),'warnings do not log a media URI or filename');
  console.log('PASS decoder fallback reuses one staged path, preserves originals, limits WAV retry and omits media paths from warnings');

  const data=Uint8Array.from([0,0,1,0,255,127,0,128]);
  const partial=synthetic(data,8,3);const values=[];
  await readPCMChunks(partial,4,async chunk=>values.push(...chunk));
  assert.deepEqual(values,[0,1/32768,32767/32768,-1]);assert.ok(partial.closed);
  const arrayFile=synthetic(data,8,3);assert.deepEqual(Array.from(await PCMtoArray(arrayFile)),values);
  const short=synthetic(data.slice(0,4),8,4);
  await assert.rejects(()=>readPCMChunks(short,4,async()=>assert.fail('partial chunk must not be emitted')),/Incomplete PCM read/);
  assert.ok(short.closed,'handle closes on failure');
  const changed=synthetic(data.slice(0,4),8,4,true);
  await assert.rejects(()=>PCMtoArray(changed),/size changed|Incomplete PCM read/);
  await assert.rejects(()=>readPCMChunks(synthetic(data,8,8),0,async()=>{}),/chunk size/);
  await assert.rejects(()=>readPCMChunks(synthetic(data,7,7),4,async()=>{}),/PCM byte length/);
  console.log('PASS exact PCM reads reassemble odd partial reads and reject EOF, changes and malformed input');

  const input=new File(work,'source.pcm');fs.writeFileSync(input.uri,data);
  const good=await PCMtoWav(input,48000);assert.equal(good.file.size,52);assert.ok(input.exists);
  for(const bad of ['short','wrong-length','bad-header','throws']){
    mode=bad;await assert.rejects(()=>PCMtoWav(input,48000),/WAV wrapping failed/);
    assert.ok(!fs.existsSync(lastOutput),`${bad} partial WAV must be deleted`);
    assert.deepEqual(fs.readFileSync(input.uri),Buffer.from(data),'original never removed or changed');
  }
  const odd=new File(work,'odd.pcm');fs.writeFileSync(odd.uri,Buffer.from([1,2,3]));
  await assert.rejects(()=>PCMtoWav(odd,48000),/Invalid.*PCM/);assert.ok(odd.exists);
  console.log('PASS WAV validation rejects partial/incorrect outputs and preserves original PCM');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>fs.rmSync(work,{recursive:true,force:true}));
