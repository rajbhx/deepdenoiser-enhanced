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
}};
const filename=path.join(__dirname,'../src/scripts/formatHandler.ts');
const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(__dirname);
const stubs={'@/modules/AudioProcessorModule':native,'expo-file-system':{File,Paths:{cache:{uri:work}}},'expo-media-library':{},
  'react-native':{Platform:{OS:'android',Version:36}},'./analytics':{},'./silenceTrim':{},'./resampler':{}};
mod.require=function(request){return Object.hasOwn(stubs,request)?stubs[request]:Module.prototype.require.call(this,request)};
mod._compile(js,filename);
const {readPCMChunks,PCMtoArray,PCMtoWav}=mod.exports;
function synthetic(bytes, reported, maxRead, changeSizeAfterRead=false) {
  let closed=false,reads=0,pos=0;
  return {exists:true,size:reported,get closed(){return closed},open(){return {
    get size(){return changeSizeAfterRead&&reads?bytes.length:reported},get offset(){return pos},set offset(v){pos=v},
    readBytes(n){reads++;const part=bytes.slice(pos,pos+Math.min(n,maxRead));pos+=part.length;return part},
    close(){closed=true},
  }}};
}
(async()=>{
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
