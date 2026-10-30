const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-recovery-'));
class File {
  constructor(...parts){this.uri=path.join(...parts.map(p=>typeof p==='string'?p:p.uri))}
  get name(){return path.basename(this.uri)} get exists(){return fs.existsSync(this.uri)} get size(){return this.exists?fs.statSync(this.uri).size:0}
  create(){fs.closeSync(fs.openSync(this.uri,'wx'))} delete(){fs.unlinkSync(this.uri)}
  open(mode){const fd=fs.openSync(this.uri,mode==='r'?'r':'r+');return{offset:0,
    readBytes(n){const b=Buffer.alloc(n);const got=fs.readSync(fd,b,0,n,this.offset);this.offset+=got;return new Uint8Array(b.buffer,b.byteOffset,got)},
    writeBytes(b){fs.writeSync(fd,b,0,b.length,this.offset);this.offset+=b.length},close(){fs.closeSync(fd)}}}
}
class Directory{constructor(...parts){this.uri=path.join(...parts.map(p=>typeof p==='string'?p:p.uri))}get exists(){return fs.existsSync(this.uri)}create(){fs.mkdirSync(this.uri,{recursive:true})}}
const doc=new Directory(root,'doc'), output=new Directory(doc,'denoised');doc.create();output.create();
let seq=0, corruptCopy=false, failLink=false, collision=false;
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const native={
  fingerprintFile:async uri=>{const b=await fs.promises.readFile(uri);return{bytes:b.length,sha256:digest(b)}},
  copyFileWithSha256:async(src,dst)=>{const b=await fs.promises.readFile(src);await fs.promises.writeFile(dst,corruptCopy?Buffer.from('corrupt'):b);return digest(b)},
  linkPrivateFileNoReplace:async(src,dst)=>{if(failLink)throw Error('synthetic link failure');if(collision){collision=false;await fs.promises.writeFile(dst,'existing');return false}try{await fs.promises.link(src,dst);return true}catch(e){if(e.code==='EEXIST')return false;throw e}},
};
const fsMock={File,Directory,FileMode:{ReadOnly:'r'},Paths:{document:doc}};
function load(name, stubs){const filename=path.join(__dirname,'../src/scripts',name+'.ts');const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(__dirname);mod.require=req=>Object.hasOwn(stubs,req)?stubs[req]:Module.prototype.require.call(mod,req);mod._compile(code,filename);return mod.exports}
const safety=load('recordingSafety',{'expo-file-system':fsMock,'@siteed/audio-studio':{AudioStudioModule:{status:()=>({isRecording:false,isPaused:false,isWriterActive:false})}}});
const recovery=load('recordingRecovery',{'expo-file-system':fsMock,'@/modules/AudioProcessorModule':native,'./recordingSafety':safety,
  './denoiseCache':{outputDir:()=>output,reservePrivateTemp:dir=>{const f=new File(dir,`_pending_repair_${seq++}.tmp`);f.create();return f}}});
function wav(samples, declared){const b=Buffer.alloc(44+samples.length*2);b.write('RIFF',0);b.writeUInt32LE(declared+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(declared,40);samples.forEach((v,i)=>b.writeInt16LE(v,44+i*2));return b}
(async()=>{
  const original=new File(doc,'original.wav'), samples=Array.from({length:600},(_,i)=>i-300);
  // Header claims substantially more data than is physically present: this
  // may be real loss, and repairing the sizes cannot manufacture the rest.
  const raw=wav(samples,10000);fs.writeFileSync(original.uri,raw);
  assert.throws(()=>safety.ensureRecordingWavHeader(original),safety.RecordingHeaderMismatchError);
  assert.deepEqual(fs.readFileSync(original.uri),raw);
  collision=true;
  const repaired=await recovery.repairRecordingCopy(original,()=>{});
  assert.notEqual(repaired.uri,original.uri);assert.deepEqual(fs.readFileSync(original.uri),raw);
  const result=fs.readFileSync(repaired.uri);
  assert.equal(result.readUInt32LE(4),result.length-8);assert.equal(result.readUInt32LE(40),samples.length*2);
  assert.deepEqual(result.subarray(44),raw.subarray(44));
  assert.ok(fs.readdirSync(output.uri).some(n=>fs.readFileSync(path.join(output.uri,n)).toString()==='existing'),'collision must not overwrite existing output');
  assert.ok(!fs.readdirSync(output.uri).some(n=>n.startsWith('_pending_')));
  console.log('PASS mismatched/truncated header warns and repairs a verified separate copy without changing any original bytes');

  corruptCopy=true;await assert.rejects(()=>recovery.repairRecordingCopy(original,()=>{}),/verified|changed/i);corruptCopy=false;
  assert.deepEqual(fs.readFileSync(original.uri),raw);assert.ok(!fs.readdirSync(output.uri).some(n=>n.startsWith('_pending_')));
  failLink=true;await assert.rejects(()=>recovery.repairRecordingCopy(original,()=>{}),/synthetic link/);failLink=false;
  assert.deepEqual(fs.readFileSync(original.uri),raw);assert.ok(!fs.readdirSync(output.uri).some(n=>n.startsWith('_pending_')));
  let safetyChecks=0;await assert.rejects(()=>recovery.repairRecordingCopy(original,()=>{if(++safetyChecks===3)throw Error('writer became active')}),/writer became active/);
  assert.deepEqual(fs.readFileSync(original.uri),raw);assert.ok(!fs.readdirSync(output.uri).some(n=>n.startsWith('_pending_')));
  const complete=new File(doc,'complete.wav');fs.writeFileSync(complete.uri,wav(samples,samples.length*2));
  await assert.rejects(()=>recovery.repairRecordingCopy(complete,()=>{}),/does not need/);
  console.log('PASS failed copy, active recorder, promotion error and already-valid input leave originals intact');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
