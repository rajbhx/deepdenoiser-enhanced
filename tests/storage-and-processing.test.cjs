const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const Module = require('node:module');
const ts = require('typescript');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepdenoiser-test-'));
const filePath = value => {
  const s = typeof value === 'string' ? value : value.uri;
  return s.startsWith('file:') ? fileURLToPath(s) : s;
};
class Directory {
  constructor(...parts) { this.uri = pathToFileURL(path.join(...parts.map(filePath))).href; }
  get exists() { return fs.existsSync(filePath(this)); }
  create() { fs.mkdirSync(filePath(this), {recursive:true}); }
  list() { return fs.readdirSync(filePath(this)).map(x => fs.statSync(path.join(filePath(this),x)).isDirectory() ? new Directory(this,x) : new File(this,x)); }
}
class File {
  constructor(...parts) { this.uri = pathToFileURL(path.join(...parts.map(filePath))).href; }
  get name() { return path.basename(filePath(this)); }
  get exists() { return fs.existsSync(filePath(this)); }
  get size() { return this.exists ? fs.statSync(filePath(this)).size : 0; }
  get modificationTime() { return this.exists ? fs.statSync(filePath(this)).mtimeMs : null; }
  get type() { return ''; }
  async text() { return fs.promises.readFile(filePath(this), 'utf8'); }
  async write(data) { await fs.promises.writeFile(filePath(this), data); }
  delete() { fs.unlinkSync(filePath(this)); }
  async move(dest, options) { if (dest.exists && !options?.overwrite) throw new Error('exists'); await fs.promises.rename(filePath(this),filePath(dest)); this.uri=dest.uri; }
  async copy(dest) { if (dest.exists) throw new Error('exists'); await fs.promises.copyFile(filePath(this),filePath(dest)); }
}
const doc = new Directory(root,'doc'), cache = new Directory(root,'cache'); doc.create(); cache.create();
const stubFs = {File, Directory, Paths:{document:doc, cache}};
function load(file, stubs={}) {
  const filename = path.join(__dirname, '../src/scripts', file+'.ts');
  const js = ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const old = Module._load;
  Module._load = function(request) { if (Object.hasOwn(stubs,request)) return stubs[request]; return old.apply(this,arguments); };
  try { const mod = new Module(filename,module); mod.filename=filename; mod.paths=Module._nodeModulePaths(__dirname); mod._compile(js,filename); return mod.exports; }
  finally { Module._load=old; }
}
let copyCount=0;
const cacheApi = load('denoiseCache', {
  '@/assets/model/model_metadata.json':{hop_size:512,fft_size:960},
  '@/modules/AudioProcessorModule':{copyFileWithSha256:async (source,dest) => {
    copyCount++;
    const bytes=await fs.promises.readFile(filePath(source));
    await fs.promises.writeFile(filePath(dest),bytes);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }},
  'expo-file-system':stubFs,
  './formatHandler':{sanitizeFileName:s=>s.replace(/[^a-zA-Z0-9._-]/g,'_') || 'denoised'},
});
(async () => {
  const a=new File(root,'a.wav'), b=new File(root,'b.wav');
  await a.write('aaaa'); await b.write('bbbb');
  const first=await cacheApi.importToDocuments(a.uri,'same.wav');
  const second=await cacheApi.importToDocuments(b.uri,'same.wav');
  assert.notEqual(first.uri,second.uri,'same size/name but different bytes must not collide');
  assert.equal(await first.text(),'aaaa'); assert.equal(await second.text(),'bbbb');
  const firstAgain=await cacheApi.importToDocuments(a.uri,'same.wav');
  assert.equal(firstAgain.uri,first.uri,'identical content reuses durable import');
  const importDir=new Directory(doc,'imports');
  assert.ok(!fs.readdirSync(filePath(importDir)).some(n=>n.startsWith('_pending_')),'no partial imports');
  assert.notEqual(cacheApi.buildInputIdentity(first),cacheApi.buildInputIdentity(second));
  console.log('PASS full-content import identity prevents same-name/same-size collision');

  const fallback = await cacheApi.importToDocuments(new File(root,'missing').uri,'fallback.wav',a.uri);
  assert.equal(await fallback.text(),'aaaa');
  await assert.rejects(()=>cacheApi.importToDocuments(new File(root,'missing').uri,'bad.wav'));
  assert.ok(!fs.readdirSync(filePath(importDir)).some(n=>n.startsWith('_pending_')));
  console.log('PASS fallback copy and failed-import cleanup');

  const temp1=new File(cache,'out1'); const temp2=new File(cache,'out2'); await temp1.write('one'); await temp2.write('two');
  const out1=await cacheApi.placeOutput(temp1,'same_denoised.wav');
  const out2=await cacheApi.placeOutput(temp2,'same_denoised.wav');
  assert.notEqual(out1.uri,out2.uri); assert.equal(await out1.text(),'one'); assert.equal(await out2.text(),'two');
  console.log('PASS output files with duplicate names never overwrite each other');

  await Promise.all(Array.from({length:40},(_,i)=>cacheApi.storeCachedOutput('key-'+i, i%2?out1:out2)));
  for(let i=0;i<40;i++) assert.ok(await cacheApi.lookupCachedOutput('key-'+i),'lost concurrent cache index update '+i);
  for(let i=40;i<110;i++) await cacheApi.storeCachedOutput('key-'+i,out1);
  assert.ok(out1.exists && out2.exists,'pruning indexes must never delete finished media');
  console.log('PASS concurrent cache index updates are serialized and pruning preserves outputs');

  const { runSequentialQueue, ProcessingCancelled, throwIfCancelled }=load('batchQueue');
  let began=0, ended=0, token={cancelled:false}, staged;
  const processing=load('processMedia',{
    '@/assets/model/model_metadata.json':{hop_size:512,fft_size:960},
    'expo-file-system':stubFs,
    './batchQueue':{ProcessingCancelled,throwIfCancelled},
    './denoiserSingleton':{beginRun(){began++},endRun(){ended++},getDenoiser:async()=>assert.fail('no inference after cancellation')},
    './denoiseCache':{buildCacheKey:()=>'',buildDecodeKey:()=>'',buildDenoiseKey:()=>'',lookupCachedOutput:async()=>null,
      lookupDecodedPCM:async()=>null,stagePcmPath:()=> 'stage_dec_test.pcm', lookupDenoisedPCM:async()=>null},
    './formatHandler':{decodeToPCMFile:async(_input,uri)=>{staged=new File(uri); await staged.write('partial'); token.cancelled=true; return {file:staged,sampleRate:48000};}},
  });
  const settings={attenLimDb:0,normalize:{toggle:false,targetRMS:-14,maxPeakDb:-1},silenceTrim:{enabled:false,mode:'auto',thresholdDb:-40,minSilenceMs:500}};
  await assert.rejects(()=>processing.processMedia(a,'a.wav',false,settings,token,()=>{}),ProcessingCancelled);
  assert.equal(began,1); assert.equal(ended,1); assert.ok(staged && !staged.exists,'cancelled decode scratch deleted');
  console.log('PASS processing cancellation releases model run and deletes partial PCM');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
