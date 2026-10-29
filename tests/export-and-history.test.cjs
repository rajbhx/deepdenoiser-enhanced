const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dd-history-'));
class Directory {constructor(...p){this.uri=path.join(...p.map(x=>typeof x==='string'?x:x.uri))}get exists(){return fs.existsSync(this.uri)}create(){fs.mkdirSync(this.uri,{recursive:true})}list(){return fs.readdirSync(this.uri).map(n=>fs.statSync(path.join(this.uri,n)).isDirectory()?new Directory(this,n):new File(this,n))}}
class File {constructor(...p){this.uri=path.join(...p.map(x=>typeof x==='string'?x:x.uri))}get exists(){return fs.existsSync(this.uri)}get name(){return path.basename(this.uri)}get size(){return fs.statSync(this.uri).size}get modificationTime(){return fs.statSync(this.uri).mtimeMs}async write(bytes){fs.writeFileSync(this.uri,bytes)}}
function load(name,stubs={}){const filename=path.join(__dirname,'../src/scripts',`${name}.ts`);const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(__dirname);mod.require=function(req){return Object.hasOwn(stubs,req)?stubs[req]:Module.prototype.require.call(this,req)};mod._compile(js,filename);return mod.exports}
const doc=new Directory(root,'doc');doc.create();const output=new Directory(doc,'denoised'),imports=new Directory(doc,'imports'),recordings=new Directory(doc,'recordings');for(const d of [output,imports,recordings])d.create();
const file=(dir,name,data='x')=>{const f=new File(dir,name);fs.writeFileSync(f.uri,data);return f};
let savedCalls=[],requests=[],permission='granted';const platform={OS:'android',Version:33};
const format=load('formatHandler',{
  '@/modules/AudioProcessorModule':{exportMediaFile:async(...args)=>{savedCalls.push(args);return 'content://saved'}},
  'expo-file-system':{File,Directory,Paths:{document:doc,cache:doc}},
  'expo-media-library':{requestPermissionsAsync:async(...args)=>{requests.push(args);return {status:permission}}},
  'react-native':{Platform:platform},'./analytics':{trackAppEvent(){}},'./silenceTrim':{},'./resampler':load('resampler'),
});
(async()=>{
  const audio=file(output,'clean.wav'),video=file(output,'clean.mp4');
  assert.equal(await format.saveToDevice(audio),true);assert.deepEqual(savedCalls.pop(),[audio.uri,audio.name,'DeepDenoiser',false]);
  assert.equal(await format.saveToDevice(video,'Custom'),true);assert.deepEqual(savedCalls.pop(),[video.uri,video.name,'Custom',true]);
  assert.equal(requests.length,0,'Android 10+ must not request unrelated media access');
  platform.Version=28;permission='denied';assert.equal(await format.saveToDevice(audio),false);assert.deepEqual(requests.pop(),[true,['audio']]);assert.equal(savedCalls.length,0);
  permission='granted';assert.equal(await format.saveToDevice(video),true);assert.deepEqual(requests.pop(),[true,['video']]);assert.equal(savedCalls.pop()[3],true);
  const original=console.error;console.error=()=>{};try{assert.equal(await format.saveToDevice(file(output,'bad.exe')),false)}finally{console.error=original}
  console.log('PASS media export chooses collection without unrelated permissions and handles legacy denial');
  const nan=file(root,'nan.pcm','old');await assert.rejects(()=>format.writePCMChunk(nan,new Float32Array([0,NaN,1]),false),/non-finite/);assert.equal(fs.readFileSync(nan.uri,'utf8'),'old');
  console.log('PASS non-finite PCM is rejected before writing');

  const rec=file(recordings,'recording_1_original.wav');const legacy=file(doc,'12345678-abcd-abcd-abcd-123456789abc.wav');
  const partial=file(doc,'orig_123.pcm');const imp=file(imports,'a'.repeat(64)+'_voice.wav');file(imports,'_pending_temp.tmp');file(doc,'unrelated.wav');
  const history=load('privateMedia',{'expo-file-system':{File,Directory,Paths:{document:doc,cache:doc}},'./denoiseCache':{importsDir:()=>imports,outputDir:()=>output},'./recordingSafety':{recordingsDir:()=>recordings}});
  const list=history.listPrivateMedia();
  assert.ok(list.some(i=>i.file.uri===rec.uri && i.group==='recordings'));assert.ok(list.some(i=>i.file.uri===legacy.uri && i.group==='recordings'));
  assert.ok(list.some(i=>i.file.uri===imp.uri && i.name==='voice.wav'));assert.ok(list.some(i=>i.file.uri===partial.uri && i.partial));assert.ok(list.some(i=>i.file.uri===audio.uri && i.group==='results'));
  assert.ok(!list.some(i=>i.name.includes('pending') || i.name==='unrelated.wav' || i.name==='bad.exe'));
  fs.unlinkSync(video.uri);assert.ok(!history.listPrivateMedia().some(i=>i.file.uri===video.uri));
  console.log('PASS history discovers durable outputs, recoverable recordings and imports without a fragile index');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
