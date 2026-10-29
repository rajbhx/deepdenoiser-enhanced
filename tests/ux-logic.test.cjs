const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.join(__dirname, '..');
function load(name, stubs={}) {
  const filename=path.join(root, 'src/scripts', `${name}.ts`);
  const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(__dirname);
  mod.require=function(req){return Object.hasOwn(stubs,req)?stubs[req]:Module.prototype.require.call(this,req)};
  mod._compile(js,filename);return mod.exports;
}
const media=load('mediaSelection');
const slider=load('sliderMath');
const calls=[], nameQueries=[], names=new Map(), metadata=new Map(); let failAt='';
const share=load('sharedImport',{
  '@/modules/AudioProcessorModule':{getContentDisplayName:async uri=>{nameQueries.push(uri);return names.get(uri)||''}},
  './mediaSelection':media,
  './denoiseCache':{
    importToDocuments:async(uri,name,_fallback,kind)=>{
      calls.push({uri,name,kind});if(uri===failAt)throw new Error('grant expired');
      const file={uri:`file:///imports/${uri.split('/').pop()}_${name}`};
      if(!metadata.has(file.uri))metadata.set(file.uri,kind);return file;
    },
    readImportedMediaKind:file=>metadata.get(file.uri)||null,
  },
});
const payload=(value,mimeType,shareType='file')=>({value,mimeType,shareType});
(async()=>{
  names.set('content://one','same-name.mp4');names.set('content://two','same-name.mp4');
  const chosen=await share.importSharedMedia([
    payload('content://one','video/mp4','video'),payload('content://two','audio/mp4','audio'),payload('content://one','video/mp4','video'),
  ]);
  assert.equal(chosen.length,2,'different source URIs with the same name remain separate');
  assert.deepEqual(chosen.map(x=>x.kind),['video','audio']);
  assert.deepEqual(calls.map(x=>x.uri),['content://one','content://two']);
  console.log('PASS multi-share imports all distinct raw URIs and preserves each MIME kind');

  calls.length=0;
  await assert.rejects(()=>share.importSharedMedia([payload('content://one','video/mp4','video'),payload('content://image','image/png','image')]),/not audio or video/);
  assert.equal(calls.length,0,'reject the whole batch before copying any invalid item');
  const tooMany=Array.from({length:21},(_,i)=>payload(`content://item/${i}`,'audio/wav','audio'));
  await assert.rejects(()=>share.importSharedMedia(tooMany),/up to 20 unique files/);assert.equal(calls.length,0);
  await assert.rejects(()=>share.importSharedMedia([payload('https://example.com/a.mp3','audio/mpeg','audio')]),/accessible local file/);
  names.set('content://bad','second.wav');failAt='content://bad';
  await assert.rejects(()=>share.importSharedMedia([payload('content://one','video/mp4','video'),payload('content://bad','audio/wav','audio')]),/1 earlier copied file\(s\) remain/);
  console.log('PASS multi-share rejects unsupported/oversized batches and reports partially retained imports');

  failAt='';calls.length=0;nameQueries.length=0;
  const duplicate=payload('content://one','video/mp4','video');
  await assert.rejects(()=>share.importSharedMedia(Array.from({length:201},()=>duplicate)),/Too many shared items/);
  assert.equal(nameQueries.length,0,'raw batch limit applies before provider access');assert.equal(calls.length,0);
  await assert.rejects(()=>share.importSharedMedia([duplicate,payload('content://one','audio/wav','audio')]),/conflicting type information/);
  assert.equal(nameQueries.length,0,'conflicting metadata is rejected before querying or copying');assert.equal(calls.length,0);
  const limited=await share.importSharedMedia(Array.from({length:200},()=>duplicate));
  assert.equal(limited.length,1);assert.equal(nameQueries.length,1);assert.equal(calls.length,1);
  assert.equal(media.mediaKind('clip.3gp','application/octet-stream'),'video');
  assert.equal(media.mediaKind('clip.MPEG',null),'video');
  assert.equal(media.mediaKind('clip.wav','AUDIO/WAV'),'audio');
  console.log('PASS raw share work is bounded, duplicate conflicts fail closed, and video extension fallback is consistent');

  const claims=load('shareClaim');let wakeups=0;const unsub=claims.onShareClaimReleased(()=>wakeups++);
  const a=claims.claimSharedBatch(['a','b']);assert.ok(a);assert.equal(claims.claimSharedBatch(['b','a']),null);
  assert.equal(claims.claimSharedBatch(['different']),null,'new batches wait for the current claim');
  claims.finishSharedBatch(a);assert.equal(wakeups,1);const repeat=claims.claimSharedBatch(['a','b']);assert.ok(repeat,'identical later shares are not silently suppressed');claims.finishSharedBatch(repeat);unsub();
  console.log('PASS incoming-share claims serialize consumers and allow a later identical share');

  const item={uri:'file:///private/import',name:'clip',kind:'video'};
  const encode=x=>encodeURIComponent(JSON.stringify(x));
  assert.deepEqual(media.decodeMediaSelection(encode([item])),[item]);
  assert.deepEqual(media.decodeMediaSelection(encode([item,{...item,uri:'https://example.com'}])),[],'malformed batch is never truncated');
  assert.deepEqual(media.decodeMediaSelection(encode(Array.from({length:21},()=>item))),[],'oversized batches are never silently truncated');
  assert.equal(slider.sliderProgress(13,0,40,[0,5,10,15,20,30,40]),(2+3/5)/6);
  assert.equal(slider.adjustedSliderValue(13,1,0,40,[0,5,10,15,20,30,40]),15);
  assert.equal(slider.adjustedSliderValue(13,-1,0,40,[0,5,10,15,20,30,40]),10);
  assert.equal(slider.adjustedSliderValue(-14,1,-20,-10,undefined,0),-13);
  assert.equal(slider.adjustedSliderValue(-10,1,-20,-10,undefined,0),-10);
  console.log('PASS strict batch validation and accessible slider calculations');

  const hook=fs.readFileSync(path.join(root,'src/scripts/useRawIncomingShare.ts'),'utf8');
  const screens=['src/app/(tabs)/index.tsx','src/app/share-handler.tsx'].map(name=>fs.readFileSync(path.join(root,name),'utf8')).join('\n');
  assert.match(hook,/getSharedPayloads/);assert.doesNotMatch(hook,/getResolvedSharedPayloadsAsync\s*\(/);
  assert.doesNotMatch(screens,/useIncomingShare\s*\(/,'unsafe cache-copying resolver must never run');
  const config=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
  const plugin=config.expo.plugins.find(x=>Array.isArray(x)&&x[0]==='expo-sharing');
  assert.ok(plugin[1].android.multipleShareMimeTypes.includes('*/*'),'Android mixed audio/video intents must match');
  console.log('PASS Android multiple-share configuration bypasses the unsafe resolver');
})().catch(error=>{console.error(error);process.exitCode=1});
