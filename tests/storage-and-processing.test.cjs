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
  textSync() { return fs.readFileSync(filePath(this), 'utf8'); }
  async write(data) { await fs.promises.writeFile(filePath(this), data); }
  create() { fs.closeSync(fs.openSync(filePath(this), 'wx')); }
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
let copyCount=0, activeRun=false;
const cacheApi = load('denoiseCache', {
  '@/assets/model/model_metadata.json':{hop_size:512,fft_size:960},
  '@/modules/AudioProcessorModule':{atomicReplaceFile: async (src,dst)=>{await fs.promises.rename(filePath(src),filePath(dst));return dst}, copyFileWithSha256:async (source,dest) => {
    copyCount++;
    const bytes=await fs.promises.readFile(filePath(source));
    await fs.promises.writeFile(filePath(dest),bytes);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }, fingerprintFile:async source=>{const bytes=await fs.promises.readFile(filePath(source));return {bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}},
  linkPrivateFileNoReplace:async (src,dst)=>{try {await fs.promises.link(filePath(src),filePath(dst));return true} catch(e){if(e.code==='EEXIST')return false;throw e}}},
  './denoiserSingleton':{isProcessingMedia:()=>activeRun},
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

  // The digest-named original can be damaged without changing its length.
  // Reimport must never reuse or overwrite it; a separately verified copy wins.
  await first.write('zzzz'); let corruptionWarnings=0;
  const repairedImport=await cacheApi.importToDocuments(a.uri,'same.wav',undefined,'audio',()=>corruptionWarnings++);
  assert.notEqual(repairedImport.uri,first.uri);assert.equal(await first.text(),'zzzz');
  assert.equal(await repairedImport.text(),'aaaa');assert.equal(corruptionWarnings,1);
  const again=await cacheApi.importToDocuments(a.uri,'same.wav',undefined,'audio',()=>corruptionWarnings++);
  assert.equal(again.uri,repairedImport.uri,'a previously verified alternate may be reused only after hashing');
  assert.equal(corruptionWarnings,2);assert.equal(await first.text(),'zzzz');
  // Competing promotions into one absent name use an atomic no-replace link.
  const raceSource=new File(root,'concurrent.wav');await raceSource.write('concurrent bytes');
  const winners=await Promise.all(Array.from({length:32},()=>cacheApi.importToDocuments(raceSource.uri,'race.wav')));
  assert.equal(new Set(winners.map(f=>f.uri)).size,1);
  assert.equal(await winners[0].text(),'concurrent bytes');
  assert.ok(!fs.readdirSync(filePath(importDir)).some(n=>n.startsWith('_pending_')));

  const longName='x'.repeat(166)+'.wav',longSource=new File(root,'long.wav');await longSource.write('long-data');
  const longOriginal=await cacheApi.importToDocuments(longSource.uri,longName);await longOriginal.write('broken---');
  const longAlternate=await cacheApi.importToDocuments(longSource.uri,longName);await longAlternate.write('bad------');
  const thirdLong=await cacheApi.importToDocuments(longSource.uri,longName);
  assert.equal(await thirdLong.text(),'long-data');assert.equal(await longOriginal.text(),'broken---');assert.equal(await longAlternate.text(),'bad------');
  assert.ok(thirdLong.name.length<=255,'recovered names must fit ordinary Android filename limits');
  console.log('PASS corrupted imports are retained, separately reimported, verified on reuse, and concurrent promotions never replace');


  assert.equal(cacheApi.readImportedMediaKind(first), null, 'legacy imports are explicitly unknown');
  await cacheApi.setImportedMediaKind(first, 'video');
  assert.equal(cacheApi.readImportedMediaKind(first), 'video');
  await cacheApi.importToDocuments(a.uri, 'same.wav', undefined, 'audio');
  assert.equal(cacheApi.readImportedMediaKind(first), 'video', 'duplicate re-import must preserve the user-selected kind');
  await cacheApi.setImportedMediaKind(first, 'audio');
  assert.equal(cacheApi.readImportedMediaKind(first), 'audio', 'the user can correct a classification');
  await assert.rejects(()=>cacheApi.setImportedMediaKind(a, 'video'), /Invalid imported media type/);
  assert.ok(!fs.readdirSync(filePath(importDir)).some(n=>n.endsWith('.kind.json')), 'metadata is never listed as media');
  console.log('PASS atomic media-kind metadata persists, preserves duplicate imports and supports correction');

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
  for(let i=0;i<40;i++) assert.ok(await cacheApi.lookupCachedOutput('key-'+i,'audio'),'lost concurrent cache index update '+i);
  for(let i=40;i<110;i++) await cacheApi.storeCachedOutput('key-'+i,out1);
  assert.ok(out1.exists && out2.exists,'pruning indexes must never delete finished media');
  console.log('PASS concurrent cache index updates are serialized and pruning preserves outputs');

  const keySettings={attenLimDb:0,normalize:{toggle:false,targetRMS:-14,maxPeakDb:-1},silenceTrim:{enabled:false,mode:'auto',thresholdDb:-40,minSilenceMs:500}};
  const audioKey=cacheApi.buildCacheKey(first,keySettings,'audio'), videoKey=cacheApi.buildCacheKey(first,keySettings,'video');
  assert.notEqual(audioKey,videoKey,'audio and video results cannot share an output key');
  await cacheApi.storeCachedOutput(videoKey,out1);
  assert.equal(await cacheApi.lookupCachedOutput(videoKey,'video'),null,'a WAV cannot be returned as a video result');
  assert.ok(out1.exists,'invalid cache references must not delete user output');
  const outputIndex=new File(doc,'denoiser_cache.json');const broken=JSON.parse(await outputIndex.text());broken.malformed={path:42,createdAt:0};broken.outside={path:a.uri,createdAt:0};await outputIndex.write(JSON.stringify(broken));
  assert.equal(await cacheApi.lookupCachedOutput('malformed','audio'),null);assert.equal(await cacheApi.lookupCachedOutput('outside','audio'),null);assert.ok(a.exists&&out1.exists);
  console.log('PASS output cache is kind-aware and safely rejects mismatched or corrupt references');

  // The old WAV fallback could have produced clipped negative samples. Its
  // indexes do not say which decoder was used, so all old decode, denoise and
  // output keys must miss without touching any durable output or original.
  const identity=cacheApi.buildInputIdentity(first);
  const oldDec=['dec-v3-full-eos',identity].join('|'), newDec=cacheApi.buildDecodeKey(first);
  const newDn=cacheApi.buildDenoiseKey(first,keySettings), oldDn=newDn.replace('dfn3-v5-signed-wav','dfn3-v4-verified-pcm');
  const oldOut=audioKey.replace('dfn3-v5-signed-wav','dfn3-v4-verified-pcm');
  assert.notEqual(newDec,oldDec);assert.notEqual(newDn,oldDn);assert.notEqual(audioKey,oldOut);
  const previousDecode=new File(cache,'stage_dec_100_a.pcm'), previousDenoise=new File(cache,'stage_dn_100_b.pcm');
  await previousDecode.write('old!');await previousDenoise.write('old?');
  await cacheApi.storeDecodedPCM(oldDec,previousDecode,48000);
  await cacheApi.storeDenoisedPCM(oldDn,previousDenoise);
  await cacheApi.storeCachedOutput(oldOut,out1);
  assert.ok(await cacheApi.lookupDecodedPCM(oldDec));assert.ok(await cacheApi.lookupDenoisedPCM(oldDn));
  assert.ok(await cacheApi.lookupCachedOutput(oldOut,'audio'));
  assert.equal(await cacheApi.lookupDecodedPCM(newDec),null);
  assert.equal(await cacheApi.lookupDenoisedPCM(newDn),null);
  assert.equal(await cacheApi.lookupCachedOutput(audioKey,'audio'),null);
  assert.ok(first.exists && out1.exists && previousDecode.exists && previousDenoise.exists);
  await cacheApi.clearRebuildableCache(()=>{});
  assert.ok(first.exists && out1.exists,'cache invalidation/clearing never deletes originals or finished media');
  console.log('PASS potentially affected old cache keys are not reused and durable originals and results remain');

  const decoded=new File(cache,'stage_dec_123_a1.pcm'), cleaned=new File(cache,'stage_dn_456_b2.pcm');
  const emergency=new File(cache,'orig_123.pcm'), impostor=new File(doc,'stage_dec_789_c3.pcm');
  await decoded.write('decode');await cleaned.write('clean!');await emergency.write('original');await impostor.write('not-cache');
  await cacheApi.storeDecodedPCM('decode',decoded,48000);await cacheApi.storeDenoisedPCM('denoise',cleaned);
  await assert.rejects(()=>cacheApi.storeDecodedPCM('unsafe-original',emergency,48000),/Invalid decoded/);
  await assert.rejects(()=>cacheApi.storeDecodedPCM('unsafe-location',impostor,48000),/Invalid decoded/);
  const decodeIndex=new File(doc,'decode_cache.json');const unsafeIndex=JSON.parse(await decodeIndex.text());
  unsafeIndex['unsafe-original']={path:emergency.uri,createdAt:0};unsafeIndex['unsafe-location']={path:impostor.uri,createdAt:0};
  await decodeIndex.write(JSON.stringify(unsafeIndex));
  assert.equal(await cacheApi.getRebuildableCacheBytes(),12,'only indexed, verified stage bytes count as reclaimable');
  await assert.rejects(()=>cacheApi.clearRebuildableCache(()=>{throw new Error('busy')}),/busy/);
  assert.ok(decoded.exists && cleaned.exists && emergency.exists && impostor.exists);
  let releaseRead, markRead; const gate=new Promise(resolve=>{releaseRead=resolve}), started=new Promise(resolve=>{markRead=resolve});
  const oldText=File.prototype.text; let block=true;
  File.prototype.text=async function(){if(block&&this.name==='decode_cache.json'){markRead();await gate;}return oldText.call(this)};
  let busy=false; const clearing=cacheApi.clearRebuildableCache(()=>{if(busy)throw new Error('new run started')});
  await started;busy=true;block=false;releaseRead();await assert.rejects(()=>clearing,/new run started/);File.prototype.text=oldText;
  assert.ok(decoded.exists && cleaned.exists,'safety is rechecked inside the lock after asynchronous reads');
  await cacheApi.clearRebuildableCache(()=>{});
  assert.ok(!decoded.exists && !cleaned.exists);assert.ok(emergency.exists && impostor.exists && out1.exists && first.exists);
  assert.equal(await cacheApi.getRebuildableCacheBytes(),0);
  console.log('PASS cache clearing preserves recordings, backups, imports and outputs and guards processing races');

  const verified=new File(cache,'stage_dec_789_d4.pcm');await verified.write('abcdefgh');
  await cacheApi.storeDecodedPCM('verified',verified,48000);
  assert.ok(await cacheApi.lookupDecodedPCM('verified'),'complete stage is reusable');
  await verified.write('ABCDEFGH');
  assert.equal(await cacheApi.lookupDecodedPCM('verified'),null,'same-size corrupted stage must not be reused');
  assert.ok(verified.exists,'unverified media is not blindly deleted');
  await cacheApi.storeDecodedPCM('verified',verified,48000);
  await verified.write('ABCD');
  assert.equal(await cacheApi.lookupDecodedPCM('verified'),null,'truncated stage must not be reused');
  const denVerified=new File(cache,'stage_dn_790_d5.pcm');await denVerified.write('12345678');
  await cacheApi.storeDenoisedPCM('den-verified',denVerified);await denVerified.write('87654321');
  assert.equal(await cacheApi.lookupDenoisedPCM('den-verified'),null,'same-size denoise corruption is rejected');
  const userTemp=new File(cache,'user-output');await userTemp.write('wav-data');
  const userOut=await cacheApi.placeOutput(userTemp,'verify.wav');
  await cacheApi.storeCachedOutput('user-output',userOut);await userOut.write('tampered');
  assert.equal(await cacheApi.lookupCachedOutput('user-output','audio'),null);
  assert.ok(userOut.exists,'invalid output index must never delete user media');
  console.log('PASS SHA-256 and byte-length checks reject truncated and same-size changed cache/output files');

  const giant=new File(cache,'stage_dec_999_e5.pcm');await giant.write('');fs.truncateSync(filePath(giant),512*1024*1024+2);
  const oversizedIndex=JSON.parse(await decodeIndex.text());oversizedIndex.giant={path:giant.uri,createdAt:1};await decodeIndex.write(JSON.stringify(oversizedIndex));
  activeRun=true;await cacheApi.pruneRebuildableCache();assert.ok(giant.exists,'never prune a stage while processing or recording');
  activeRun=false;await cacheApi.pruneRebuildableCache();assert.ok(!giant.exists,'idle PCM cache is byte-bounded');
  assert.ok(emergency.exists&&first.exists&&userOut.exists,'byte pruning preserves recoverable/user files');
  console.log('PASS idle stage cache is byte-bounded without deleting recordings or active data');

  const { runSequentialQueue, ProcessingCancelled, throwIfCancelled }=load('batchQueue');
  let began=0, ended=0, token={cancelled:false}, staged;
  const processing=load('processMedia',{
    '@/assets/model/model_metadata.json':{hop_size:512,fft_size:960},
    'expo-file-system':stubFs,
    './batchQueue':{ProcessingCancelled,throwIfCancelled},
    './diagnostics':{recordDiagnostic(){},recordDiagnosticError(){}},
    './alignedDenoiseStream':load('alignedDenoiseStream'),
    './denoiserSingleton':{beginRun(){began++},endRun(){ended++},getDenoiser:async()=>assert.fail('no inference after cancellation')},
    './denoiseCache':{buildCacheKey:()=>'',buildDecodeKey:()=>'',buildDenoiseKey:()=>'',lookupCachedOutput:async()=>null,
      lookupDecodedPCM:async()=>null,stagePcmPath:()=> 'stage_dec_test.pcm', lookupDenoisedPCM:async()=>null, pruneRebuildableCache:async()=>{}},
    './formatHandler':{decodeToPCMFile:async(_input,uri)=>{staged=new File(uri); await staged.write('partial'); token.cancelled=true; return {file:staged,sampleRate:48000};}},
  });
  const settings={attenLimDb:0,normalize:{toggle:false,targetRMS:-14,maxPeakDb:-1},silenceTrim:{enabled:false,mode:'auto',thresholdDb:-40,minSilenceMs:500}};
  await assert.rejects(()=>processing.processMedia(a,'a.wav',false,settings,token,()=>{}),ProcessingCancelled);
  assert.equal(began,1); assert.equal(ended,1); assert.ok(staged && !staged.exists,'cancelled decode scratch deleted');
  console.log('PASS processing cancellation releases model run and deletes partial PCM');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
