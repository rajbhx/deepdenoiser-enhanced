/* Privacy, lifecycle and reservation tests. Mocked services are not an Android-device test. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.join(__dirname, '..');
function load(relative, stubs = {}) {
  const filename = path.join(root, 'src/scripts', relative + '.ts');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText;
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = request => Object.hasOwn(stubs, request) ? stubs[request] : Module.prototype.require.call(mod, request);
  mod._compile(js, filename); return mod.exports;
}
const core = load('diagnosticsCore');
const privateText = 'content://provider/private/secret-voice.wav /storage/emulated/0/notes.wav alice@example.com';
const clean = core.safeEvent({domain:'record',stage:'record-stop',code:'FAIL_IO',level:'error',time:1,raw:privateText,stack:privateText});
assert.deepEqual(clean, {domain:'record',stage:'record-stop',code:'FAIL_IO',level:'error',time:1});
assert.equal(core.safeEvent({...clean,stage:privateText}), null);
assert.equal(core.safeEvent({...clean,elapsedMs:86400001}), null);
assert.equal(core.classifyDiagnosticError(new Error(`Permission denied ${privateText}`),'record'),'FAIL_PERMISSION');
assert.equal(core.classifyDiagnosticError(new Error('Out of memory'),'process'),'FAIL_MEMORY');
assert.equal(core.classifyDiagnosticError(new Error('Incomplete PCM read'),'process'),'FAIL_INTEGRITY');
assert.equal(core.classifyDiagnosticError(new Error('Cancelled'),'process'),'CANCELLED');
const restored = core.parseHistory({version:1,enabled:true,events:Array.from({length:70},(_,i)=>({...clean,time:i,raw:privateText}))});
assert.equal(restored.length,50); assert.equal(restored[0].time,20); assert.ok(!JSON.stringify(restored).includes('secret-voice'));
console.log('PASS diagnostics history enforces categories, duration bounds, 50-entry cap and drops private extra fields');

let raw = null, writes = [], deletes = 0, failWrite = false, failDelete = false;
const native = {
  readDiagnosticHistory: async()=>raw,
  writeDiagnosticHistory: async json=>{if(failWrite)throw Error('disk failed');writes.push(json);raw=json;return true},
  deleteDiagnosticHistory: async()=>{if(failDelete)throw Error('delete failed');deletes++;raw=null;return true},
};
const diag = load('diagnostics', {'@/modules/AudioProcessorModule':native,'./diagnosticsCore':core});
const reportMod = load('diagnosticReport', {'./diagnosticsCore':core});
const pause = ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  await diag.initializeDiagnostics();
  diag.recordDiagnosticError('import','import',new Error(`Permission denied ${privateText}`));
  for(let i=0;i<75;i++)diag.recordDiagnostic('process','decode','START');
  assert.equal(diag.getDiagnosticSnapshot().events.length,50);
  assert.equal(writes.length,0,'no persistence without opt-in');
  await diag.setDiagnosticPersistence(true);
  assert.equal(diag.getDiagnosticSnapshot().persistent,true); assert.equal(writes.length,1);
  assert.ok(!writes[0].includes('secret-voice') && !writes[0].includes('alice@example.com'));
  diag.recordDiagnosticError('record','record-stop',new Error(`Recorder stopped ${privateText}`));
  await diag.clearDiagnosticHistory(); assert.equal(diag.getDiagnosticSnapshot().events.length,0);
  assert.deepEqual(JSON.parse(writes.at(-1)).events,[],'clear persisted ring without deleting media');
  diag.recordDiagnostic('process','decode','START');
  await diag.setDiagnosticPersistence(false);
  const afterDisable = writes.length; await pause(900);
  assert.equal(writes.length,afterDisable,'queued timers cannot recreate history after opt-out');
  assert.equal(raw,null); assert.ok(deletes>=1); assert.equal(diag.getDiagnosticSnapshot().persistent,false);
  failWrite=true; await assert.rejects(()=>diag.setDiagnosticPersistence(true));
  assert.equal(diag.getDiagnosticSnapshot().persistent,false); failWrite=false;
  await diag.setDiagnosticPersistence(true); failDelete=true;
  await assert.rejects(()=>diag.setDiagnosticPersistence(false));
  assert.equal(diag.getDiagnosticSnapshot().persistent,true,'do not claim deletion when native storage failed');
  failDelete=false; await diag.setDiagnosticPersistence(false);
  console.log('PASS opt-in, clear, opt-out, pending-write race and storage failures fail safely');

  let originalCalled=0, captured;
  global.ErrorUtils={getGlobalHandler:()=>((e,f)=>{originalCalled++;captured=[e,f]}),setGlobalHandler:h=>{global._ddHandler=h}};
  diag.installDiagnosticGlobalHandler();
  const fatal=new Error(`fatal ${privateText}`); global._ddHandler(fatal,true);
  assert.equal(originalCalled,1); assert.equal(captured[0],fatal);assert.equal(captured[1],true);
  assert.ok(!JSON.stringify(diag.getDiagnosticSnapshot()).includes('secret-voice'));
  delete global.ErrorUtils; delete global._ddHandler;
  console.log('PASS uncaught JS observation delegates to original handler and stores no raw exception');

  const info={versionName:'2.0.2',versionCode:4,debuggable:false,certificateSha256:'a'.repeat(64),androidDebugSubject:true,
    manufacturer:'PrivateBrand',model:'PrivateModel',androidVersion:'14',sdk:34,abi:'arm64-v8a',cpuCount:8,
    availableMemoryBytes:2**30,totalMemoryBytes:4*2**30,processPssBytes:2**28,freeStorageBytes:10*2**30,
    batteryPercent:42,microphoneGranted:true,notificationsEnabled:true,mediaAudioGranted:false,mediaVideoGranted:false,previousExit:null};
  const input={info,buildCommit:'1e7fd36',settings:{runtime:'auto'},engine:'cpu x4',recorder:'idle',busy:false,share:'none',
    events:[{...clean,raw:privateText}],selfCheck:null,benchmarks:{},includeDevice:false};
  const publicReport=reportMod.buildDiagnosticReport(input);
  assert.ok(!publicReport.includes('PrivateBrand') && !publicReport.includes('PrivateModel') && !publicReport.includes('secret-voice'));
  assert.ok(publicReport.includes('FAIL_IO') && publicReport.includes('actual hardware not verified'));
  const deviceReport=reportMod.buildDiagnosticReport({...input,includeDevice:true});
  assert.ok(deviceReport.includes('PrivateBrand PrivateModel')); assert.ok(!deviceReport.includes('alice@example.com'));
  console.log('PASS report preview omits device details by default and never serializes raw event fields');

  let releaseCount=0, loads=[];
  class FakeModel { constructor(){this.lastEngine='not-loaded'} async loadModel(_uri,mode){loads.push(mode);this.lastEngine=mode} async release(){releaseCount++} }
  const singleton=load('denoiserSingleton', {
    'expo-asset':{Asset:{fromModule:()=>({localUri:'file:///bundled-model',downloadAsync:async()=>{}})}},
    './Denoiser':{DeepFilterNet:FakeModel},
    './settings':{getSettings:async()=>({runtime:'cpu',coreMode:'auto'}),resolveCoreLevel:()=>4},
    '@/assets/model/denoiser_model.ort':'bundled-model',
  });
  singleton.beginRun(); assert.equal(singleton.beginDiagnosticRun(),false); singleton.endRun();
  assert.equal(singleton.beginDiagnosticRun(),true); assert.equal(singleton.isProcessingMedia(),true);
  assert.throws(()=>singleton.beginRun(),/Diagnostics are running/);
  assert.equal(singleton.beginDiagnosticRun(),false); singleton.endDiagnosticRun();
  assert.equal(singleton.isProcessingMedia(),false); assert.equal(singleton.beginDiagnosticRun(),true);
  await singleton.withDiagnosticModel('nnapi',async model=>assert.equal(model.lastEngine,'nnapi'));
  singleton.endDiagnosticRun(); assert.equal(singleton.isProcessingMedia(),false);assert.equal(releaseCount,1);assert.deepEqual(loads,['nnapi']);
  console.log('PASS diagnostics reserve the model, block concurrent work and release isolated sessions');

  // Exercise synthetic self-check behavior with an in-memory fake filesystem.
  // These mocks cannot validate Expo or Android file/codec behavior.
  const crypto=require('node:crypto');
  const files=new Map([['file:///cache/my-recording.wav',Buffer.from('keep user audio')]]);
  const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
  let idle=true,reserved=false,forceCollision=false,shortRead=false,modelHashOk=true,badOutput=false,modelCalls=0;
  class TestFile {
    constructor(dir,name){this.uri=dir.uri+'/'+name}
    get exists(){return files.has(this.uri)}
    create(){
      if(forceCollision && this.uri.endsWith('.pcm')) { files.set(this.uri,Buffer.from('foreign file')); throw Error('exists') }
      if(files.has(this.uri)) throw Error('exists'); files.set(this.uri,Buffer.alloc(0));
    }
    write(bytes){files.set(this.uri,Buffer.from(bytes))}
    async bytes(){return new Uint8Array(files.get(this.uri))}
    open(){const uri=this.uri;return {offset:0,readBytes(count){const data=files.get(uri);return new Uint8Array(data.subarray(0,shortRead?data.length-1:count))},close(){}}}
    delete(){files.delete(this.uri)}
  }
  const fakeModel={lastEngine:'cpu x4',async denoise(signal){modelCalls++;return badOutput?new Float32Array([NaN]):new Float32Array(signal)}};
  const fakeNative={
    fingerprintFile:async uri=>uri==='file:///model' ? {sha256:modelHashOk?'ec5ec24059035741763006dfaa6d463cfbbacf496caed5b5599ebe3477f2dd5b':'bad',bytes:1} : {sha256:hash(files.get(uri)),bytes:files.get(uri).length},
    pcmToWav:async(pcm,wav)=>{const data=files.get(pcm),header=Buffer.alloc(44);header.write('RIFF',0);header.write('WAVE',8);header.write('data',36);header.writeUInt32LE(data.length,40);files.set(wav,Buffer.concat([header,data]))},
  };
  const self=load('diagnosticSelfCheck',{
    '@/modules/AudioProcessorModule':fakeNative,'expo-file-system':{File:TestFile,Paths:{cache:{uri:'file:///cache'}}},
    './denoiserSingleton':{beginDiagnosticRun:()=>{if(reserved)return false;reserved=true;return true},endDiagnosticRun:()=>{reserved=false},getBundledModelUri:async()=> 'file:///model',getDenoiser:async()=>fakeModel,withDiagnosticModel:async(_mode,run)=>run(fakeModel)},
    './diagnostics':{recordDiagnostic(){},recordDiagnosticError(){}},
    './recordingSafety':{assertNativeRecorderIdle:()=>{if(!idle)throw Error('writer active')}},
  });
  let result=await self.runDiagnosticSelfCheck();
  assert.deepEqual(result.checks.map(c=>[c.id,c.status]),[['private-file','passed'],['wav','passed'],['model-hash','passed'],['model-run','passed']]);
  assert.equal(reserved,false);assert.equal(files.size,1);assert.equal(files.get('file:///cache/my-recording.wav').toString(),'keep user audio');
  shortRead=true;result=await self.runDiagnosticSelfCheck();shortRead=false;
  assert.equal(result.checks.find(c=>c.id==='private-file').status,'failed');assert.equal(result.checks.some(c=>c.id==='wav'),false);assert.equal(files.size,1);
  forceCollision=true;result=await self.runDiagnosticSelfCheck();forceCollision=false;
  assert.equal(result.checks.find(c=>c.id==='private-file').status,'failed');
  const foreign=[...files].find(([name])=>name.endsWith('.pcm'));assert.ok(foreign);assert.equal(foreign[1].toString(),'foreign file');files.delete(foreign[0]);
  modelHashOk=false;const beforeModel=modelCalls;result=await self.runDiagnosticSelfCheck();modelHashOk=true;
  assert.equal(result.checks.find(c=>c.id==='model-hash').status,'failed');assert.equal(result.checks.find(c=>c.id==='model-run').status,'warning');assert.equal(modelCalls,beforeModel);
  badOutput=true;result=await self.runDiagnosticSelfCheck();badOutput=false;assert.equal(result.checks.find(c=>c.id==='model-run').status,'failed');
  idle=false;await assert.rejects(()=>self.runDiagnosticSelfCheck(),/recorder is idle/);idle=true;
  reserved=true;await assert.rejects(()=>self.runDiagnosticSelfCheck(),/Recording or processing is active/);reserved=false;
  result=await self.benchmarkDiagnosticProvider('nnapi');assert.equal(result.checks[0].status,'passed');assert.equal(reserved,false);assert.equal(files.size,1);
  console.log('PASS synthetic self-check handles idle guards, collision ownership, short reads, model hash and malformed outputs');
})().catch(error=>{console.error(error);process.exitCode=1});
