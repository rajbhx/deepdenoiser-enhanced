const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-recording-'));
class File {
  constructor(...parts) { this.uri=path.join(...parts.map(p=>typeof p==='string'?p:p.uri)); }
  get exists(){return fs.existsSync(this.uri)}
  get size(){return this.exists?fs.statSync(this.uri).size:0}
  open(){
    const fd=fs.openSync(this.uri,'r+');
    return {offset:0, readBytes(n){const b=Buffer.alloc(n);const got=fs.readSync(fd,b,0,n,this.offset);this.offset+=got;return new Uint8Array(b.buffer,b.byteOffset,got)},
      writeBytes(b){fs.writeSync(fd,b,0,b.length,this.offset);this.offset+=b.length},close(){fs.closeSync(fd)}};
  }
}
class Directory{constructor(...parts){this.uri=path.join(...parts.map(p=>typeof p==='string'?p:p.uri))}get exists(){return fs.existsSync(this.uri)}create(){fs.mkdirSync(this.uri,{recursive:true})}}
function load(name, stubs={}) {
  const filename=path.join(__dirname,'../src/scripts',`${name}.ts`);
  const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod=new Module(filename,module); mod.filename=filename; mod.paths=Module._nodeModulePaths(__dirname);
  mod.require=function(req){return Object.hasOwn(stubs,req)?stubs[req]:Module.prototype.require.call(this,req)};
  mod._compile(js,filename);return mod.exports;
}
let recorderStatus={isRecording:false,isPaused:false,isWriterActive:false};
const safety=load('recordingSafety',{'expo-file-system':{File,Directory,Paths:{document:{uri:root}}},
  '@siteed/audio-studio':{AudioStudioModule:{status:()=>recorderStatus}}});
const {AlignedDenoiseStream}=load('alignedDenoiseStream');
function wav(samples, finalized=false){
  const b=Buffer.alloc(44+samples.length*2);b.write('RIFF',0);b.writeUInt32LE(finalized?b.length-8:0,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(finalized?b.length-44:0,40);samples.forEach((v,i)=>b.writeInt16LE(v,44+i*2));return b;
}
(async()=>{
  safety.assertNativeRecorderIdle();
  for (const status of [
    {isRecording:true,isPaused:false,isWriterActive:true},
    {isRecording:false,isPaused:true,isWriterActive:true},
    {isRecording:false,isPaused:false,isWriterActive:true},
    {isRecording:false,isPaused:false},
  ]) { recorderStatus=status; assert.throws(()=>safety.assertNativeRecorderIdle(),/recorder|confirm/i); }
  recorderStatus={isRecording:false,isPaused:false,isWriterActive:false};
  safety.assertNativeRecorderIdle();
  console.log('PASS recording recovery fails closed for paused, active and timed-out native writers');
  let unblock;
  const gate=new Promise(resolve=>{unblock=resolve});const seen=[];
  const queue=new safety.BoundedRecordingQueue(100,1000,async samples=>{await gate;seen.push(samples[0])});
  let accepted=0;
  for(let i=0;i<300;i++)if(queue.enqueue(new Float32Array([i])))accepted++;
  assert.equal(accepted,100);assert.equal(queue.overloaded,true);
  unblock();await queue.drain();assert.equal(seen.length,100);assert.deepEqual(seen,Array.from({length:100},(_,i)=>i));
  assert.equal(queue.enqueue(new Float32Array([99])),false,'never resume in the middle of the native recording');
  const sizeLimit=new safety.BoundedRecordingQueue(100,10,async()=>{});
  assert.equal(sizeLimit.enqueue(new Float32Array(11)),false);
  console.log('PASS live recording queue is bounded by both chunks and samples and stays prefix-only');

  const samples=Array.from({length:5009},(_,i)=>((i*311)%50000)-25000);
  const native=new File(root,'original.wav'),prefix=new File(root,'prefix.pcm');
  fs.writeFileSync(native.uri,wav(samples));
  const full=fs.readFileSync(native.uri).subarray(44); const prefixBytes=2186;
  fs.writeFileSync(prefix.uri,full.subarray(0,prefixBytes));
  const recovered=[];
  assert.equal(await safety.reconcileRecording(native,prefix,async chunk=>recovered.push(...chunk)),true);
  assert.equal(recovered.length,(full.length-prefixBytes)/2);
  recovered.forEach((v,i)=>assert.equal(v,samples[prefixBytes/2+i]/32768));
  const repaired=fs.readFileSync(native.uri);
  assert.equal(repaired.readUInt32LE(4),repaired.length-8);assert.equal(repaired.readUInt32LE(40),full.length);
  assert.deepEqual(repaired.subarray(44),full,'WAV header recovery must not alter any samples');
  console.log('PASS native WAV repairs interrupted header and restores the unstreamed final chunk');

  const bad=Buffer.from(full.subarray(0,prefixBytes));bad[21]^=1;fs.writeFileSync(prefix.uri,bad);let called=false;
  assert.equal(await safety.reconcileRecording(native,prefix,async()=>{called=true}),false);assert.equal(called,false);
  console.log('PASS a non-prefix event stream is rejected before publishing any tail');

  // A delayed identity model verifies that the exact native tail survives the
  // same aligned streamer used by the recording screen.
  fs.writeFileSync(prefix.uri,full.subarray(0,prefixBytes));
  const delay=new Float32Array(1536);let pos=0;
  const aligned=new AlignedDenoiseStream(512,1536,async frame=>{const out=new Float32Array(512);for(let i=0;i<512;i++){out[i]=delay[pos];delay[pos]=frame[i];pos=(pos+1)%delay.length}return out});
  const actual=[];
  const first=new Float32Array(prefixBytes/2);for(let i=0;i<first.length;i++)first[i]=samples[i]/32768;
  actual.push(...await aligned.push(first));
  await safety.reconcileRecording(native,prefix,async chunk=>actual.push(...await aligned.push(chunk)));
  actual.push(...await aligned.finish());
  assert.equal(actual.length,samples.length);actual.forEach((v,i)=>assert.equal(v,samples[i]/32768));
  console.log('PASS recorded output preserves exact sample count, timing and final samples');

  for (const length of [0,1,511,512,513,1535,1536,1537,8193]) {
    const delay=new Float32Array(1536);let p=0;
    const stream=new AlignedDenoiseStream(512,1536,async frame=>{const out=new Float32Array(512);for(let i=0;i<512;i++){out[i]=delay[p];delay[p]=frame[i];p=(p+1)%delay.length}return out});
    const data=Float32Array.from({length},(_,i)=>Math.sin(i*.1));const result=[];
    for(let offset=0;offset<length;offset+=317)result.push(...await stream.push(data.subarray(offset,offset+317)));
    result.push(...await stream.finish());assert.deepEqual(result,Array.from(data),`edge length ${length}`);
    await assert.rejects(()=>stream.finish(),/already finished/);
  }
  console.log('PASS aligned framing preserves arbitrary chunk boundaries and very short inputs');

  const broken=new File(root,'broken.wav');const bytes=wav(samples);bytes.write('NOPE',0);fs.writeFileSync(broken.uri,bytes);
  assert.throws(()=>safety.ensureRecordingWavHeader(broken),/unrecognized/);assert.deepEqual(fs.readFileSync(broken.uri),bytes);
  console.log('PASS unrecognized files are never modified by recording recovery');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
