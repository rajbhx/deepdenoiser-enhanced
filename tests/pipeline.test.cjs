const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL,fileURLToPath} = require('node:url');
const Module = require('node:module');
const ts = require('typescript');
function load(name, stubs={}) {
  const filename=path.join(__dirname,'../src/scripts',name+'.ts');
  const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod=new Module(filename,module); mod.filename=filename; mod.paths=Module._nodeModulePaths(__dirname);
  mod.require=function(req){return Object.hasOwn(stubs,req)?stubs[req]:Module.prototype.require.call(this,req)};
  mod._compile(js,filename); return mod.exports;
}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dd-pipeline-'));
const p=x=>{const u=typeof x==='string'?x:x.uri; return u.startsWith('file:')?fileURLToPath(u):u};
class Directory { constructor(...parts){this.uri=pathToFileURL(path.join(...parts.map(p))).href;} }
class File {
  constructor(...parts){this.uri=pathToFileURL(path.join(...parts.map(p))).href;}
  get exists(){return fs.existsSync(p(this));}
  get size(){return this.exists?fs.statSync(p(this)).size:0;}
  get name(){return path.basename(p(this));}
  delete(){fs.unlinkSync(p(this));}
  async move(dest){await fs.promises.rename(p(this),p(dest));this.uri=dest.uri;}
}
const cache=new Directory(root,'cache'), output=new Directory(root,'output');
fs.mkdirSync(p(cache));fs.mkdirSync(p(output));
const filesystem={File,Directory,Paths:{cache,document:output}};
const queue=load('batchQueue');
let counter=0,began=0,ended=0,decodes=0,frames=0,cancelAt=Infinity,failDecode=false,shortRead=false,currentToken;
const decoded=new Map(),denoised=new Map(),finals=new Map();
const fileFor = map => async key => {const v=map.get(key);return v && v.file.exists?v:null;};
const cacheApi={
  buildCacheKey:(file,settings)=>`out|${file.uri}|${JSON.stringify(settings)}`,
  buildDecodeKey:file=>`decode|${file.uri}`,
  buildDenoiseKey:(file,settings)=>`denoise|${file.uri}|${JSON.stringify(settings)}`,
  lookupCachedOutput:async key => (await fileFor(finals)(key))?.file??null,
  lookupDecodedPCM:fileFor(decoded),
  lookupDenoisedPCM:async key => (await fileFor(denoised)(key))?.file??null,
  storeDecodedPCM:async(key,file,sampleRate)=>decoded.set(key,{file,sampleRate}),
  storeDenoisedPCM:async(key,file)=>denoised.set(key,{file}),
  storeCachedOutput:async(key,file)=>finals.set(key,{file}),
  stagePcmPath:prefix=>`${prefix}_${++counter}.pcm`,
  pruneRebuildableCache:async()=>{},
  placeOutput:async(file,name)=>{const out=new File(output,`${++counter}_${name}`);await file.move(out);return out;},
};
const format={
  decodeToPCMFile:async(input,uri)=>{decodes++; const f=new File(uri); await fs.promises.copyFile(p(input),p(f)); if(failDecode)throw Error('decode failed'); return {file:f,sampleRate:48000};},
  readPCMChunks:async(file,_chunkSize,onChunk)=>{
    const bytes=await fs.promises.readFile(p(file));
    const limit=shortRead?Math.max(0,bytes.length-2):bytes.length;
    for(let offset=0;offset<limit;offset+=1400){
      const length=Math.min(1400,limit-offset), chunk=new Float32Array(length/2);
      for(let i=0;i<chunk.length;i++)chunk[i]=bytes.readInt16LE(offset+i*2)/32768;
      await onChunk(chunk,chunk.length);
    }
  },
  writePCMChunk:async(file,chunk,append)=>{
    const b=Buffer.alloc(chunk.length*2);
    for(let i=0;i<chunk.length;i++)b.writeInt16LE(Math.max(-32768,Math.min(32767,Math.trunc(chunk[i]*32768))),i*2);
    await fs.promises.writeFile(p(file),b,{flag:append?'a':'w'});
  },
  PCMtoWav:async(file)=>{const f=new File(cache,`result_${++counter}.wav`);await fs.promises.copyFile(p(file),p(f));return {file:f,trimmed:false,trimStartUs:0,trimEndUs:0};},
  mergeAudioVideo:async()=>{throw Error('unexpected video');},
  sanitizeFileName:s=>s,
};
const model={createStream:()=>({delay:new Float32Array(1536),pos:0}),processFrame:async(stream,input,dest,offset=0)=>{
  frames++; if(frames===cancelAt)currentToken.cancelled=true;
  const output=dest??new Float32Array(512);
  for(let i=0;i<input.length;i++){output[offset+i]=stream.delay[stream.pos];stream.delay[stream.pos]=input[i];stream.pos=(stream.pos+1)%stream.delay.length;}
  return output;
}};
const pipeline=load('processMedia',{
  '@/assets/model/model_metadata.json':{hop_size:512,fft_size:960,algorithmic_delay_samples:1536},
  './alignedDenoiseStream':load('alignedDenoiseStream'),
  'expo-file-system':filesystem,
  './batchQueue':queue,
  './diagnostics':{recordDiagnostic(){},recordDiagnosticError(){}},
  './denoiseCache':cacheApi,
  './formatHandler':format,
  './denoiserSingleton':{beginRun(){began++},endRun(){ended++},getDenoiser:async()=>model},
});
const settings={attenLimDb:0,normalize:{toggle:false,targetRMS:-14,maxPeakDb:-1},silenceTrim:{enabled:false,mode:'auto',thresholdDb:-40,minSilenceMs:500}};
function inputFile(name,count){const file=new File(root,name), bytes=Buffer.alloc(count*2);for(let i=0;i<count;i++)bytes.writeInt16LE(((i*311)%50000)-25000,i*2);fs.writeFileSync(p(file),bytes);return file;}
(async()=>{
  const file=inputFile('one.pcm',5009), expected=fs.readFileSync(p(file)); currentToken={cancelled:false};
  const result=await pipeline.processMedia(file,'one.wav',false,settings,currentToken,()=>{});
  assert.equal(result.cached,false); assert.deepEqual(fs.readFileSync(p(result.file)),expected,'identity model must preserve samples and exact duration');
  assert.equal(began,1);assert.equal(ended,1);assert.equal(decodes,1);
  const repeat=await pipeline.processMedia(file,'one.wav',false,settings,{cancelled:false},()=>{});
  assert.equal(repeat.cached,true);assert.equal(decodes,1);assert.equal(began,2);assert.equal(ended,2,'cache verification is protected and releases its run guard');
  console.log('PASS end-to-end file framing, exact sample count, persistent output and cache hit');
  const second=inputFile('two.pcm',8000);frames=0;cancelAt=4;currentToken={cancelled:false};
  await assert.rejects(()=>pipeline.processMedia(second,'two.wav',false,settings,currentToken,()=>{}),queue.ProcessingCancelled);
  assert.equal(began,3);assert.equal(ended,3);
  assert.ok(!fs.readdirSync(p(cache)).some(n=>n.startsWith('stage_dn_')&&!Array.from(denoised.values()).some(e=>e.file.name===n)),'uncommitted denoise stage must be deleted');
  console.log('PASS mid-inference cancellation removes uncommitted PCM and balances model lifetime');
  const third=inputFile('three.pcm',100);frames=0;cancelAt=Infinity;failDecode=true;currentToken={cancelled:false};
  await assert.rejects(()=>pipeline.processMedia(third,'three.wav',false,settings,currentToken,()=>{}),/decode failed/);
  assert.equal(began,4);assert.equal(ended,4);
  assert.ok(!fs.readdirSync(p(cache)).some(n=>n.startsWith('stage_dec_')&&!Array.from(decoded.values()).some(e=>e.file.name===n)),'partial failed decode must be deleted');
  console.log('PASS native decode failure removes partial file and releases model run');
  failDecode=false;shortRead=true;const fourth=inputFile('four.pcm',3000);currentToken={cancelled:false};
  const outputsBefore=fs.readdirSync(p(output));
  await assert.rejects(()=>pipeline.processMedia(fourth,'four.wav',false,settings,currentToken,()=>{}),/Incomplete denoised audio/);
  assert.ok(fourth.exists,'the source remains intact after a short read');
  assert.deepEqual(fs.readdirSync(p(output)),outputsBefore,'no partial output is committed');
  assert.ok(!fs.readdirSync(p(cache)).some(n=>n.startsWith('stage_dn_')&&!Array.from(denoised.values()).some(e=>e.file.name===n)));
  shortRead=false;
  console.log('PASS pipeline refuses incomplete input/output sample counts and preserves original');
  const selection=load('mediaSelection');
  const item={uri:'file:///some/path',name:'without-extension',kind:'video'};
  assert.deepEqual(selection.decodeMediaSelection(encodeURIComponent(JSON.stringify([item]))),[item]);
  assert.equal(selection.mediaKind('shared_file','video/mp4'),'video');
  assert.deepEqual(selection.decodeMediaSelection(encodeURIComponent(JSON.stringify([{...item,uri:'https://example.com'}]))),[]);
  console.log('PASS batch route validation and shared video MIME classification');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
