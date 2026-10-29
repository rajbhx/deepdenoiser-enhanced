/* React lifecycle with a generation-aware mock of the patched Android queue. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
require.extensions['.ts'] = (mod, filename) => {
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText;
  mod._compile(js, filename);
};
let serial=0, unreadable=false, overflow=0, acknowledgements=0;
const queue=[], appListeners=new Set(), urlListeners=new Set();
const enqueue = payloads => {const generation=String(++serial);queue.push({generation,payloads});return generation};
const api={
  getShareIntentGeneration:()=>queue[0]?.generation||'',
  acknowledgeShareIntent:generation=>{if(queue[0]?.generation!==generation)return false;queue.shift();acknowledgements++;return true},
  takeShareQueueOverflow:()=>{if(queue.length)return 0;const n=overflow;overflow=0;return n},
};
const subscription=(set,callback)=>{set.add(callback);return{remove:()=>set.delete(callback)}};
const mocks={
  expo:{requireNativeModule:()=>api},
  'expo-sharing':{getSharedPayloads:()=>{if(unreadable)throw new Error('Provider cannot be read');return queue[0]?.payloads.slice()||[]}},
  'expo-linking':{addEventListener:(_event,callback)=>subscription(urlListeners,callback)},
  'react-native':{AppState:{addEventListener:(_event,callback)=>subscription(appListeners,callback)}},
};
const oldLoad=Module._load;Module._load=function(request,parent,main){return Object.hasOwn(mocks,request)?mocks[request]:oldLoad.call(this,request,parent,main)};
const oldError=console.error;console.error=(...args)=>{if(!String(args[0]).includes('react-test-renderer is deprecated'))oldError(...args)};
const root=path.join(__dirname,'..','src','scripts');
const hook=require(path.join(root,'useRawIncomingShare.ts'));
const claims=require(path.join(root,'shareClaim.ts'));
let latest={};function Probe({id}){latest[id]=hook.useRawIncomingShare();return null}
const a=[{value:'content://source/same',shareType:'audio',mimeType:'audio/mpeg'}];
const b=[{value:'content://source/same',shareType:'video',mimeType:'video/mp4'}];
async function emitUrl(){await act(async()=>{for(const cb of urlListeners)cb({url:'deepdenoiser://expo-sharing'})})}
(async()=>{
  const first=enqueue(a);let tree;
  await act(async()=>{tree=create(React.createElement(React.Fragment,null,React.createElement(Probe,{id:'home'}),React.createElement(Probe,{id:'handler'})))});
  assert.equal(latest.home.generation,first);assert.deepEqual(latest.home.payloads,a);
  const claim=claims.claimSharedBatch([first]);assert.ok(claim);
  const second=enqueue(a);await emitUrl();
  assert.equal(latest.home.generation,first,'identical second intent waits behind in-flight first');
  await act(async()=>latest.home.consume(a,first));
  assert.equal(queue[0].generation,second);assert.equal(latest.handler.generation,second);
  assert.equal(hook.isCurrentShare(a,first),false,'old snapshot is stale even with identical URI and type');
  await act(async()=>latest.home.consume(a,first));
  assert.equal(queue[0].generation,second,'stale completion cannot clear identical next share');
  await act(async()=>claims.finishSharedBatch(claim));
  await act(async()=>latest.handler.consume(a,second));
  assert.equal(queue.length,0);assert.equal(acknowledgements,2);
  console.log('PASS overlapping identical shares are queued separately and stale acknowledgements cannot consume the next');

  const id=enqueue(b);unreadable=true;await emitUrl();
  assert.match(latest.home.error.message,/Provider cannot be read/);assert.equal(acknowledgements,2);
  unreadable=false;await act(async()=>latest.home.discardUnreadable());
  assert.equal(queue[0].generation,id,'now-readable share is refreshed, not discarded');
  assert.deepEqual(latest.home.payloads,b);
  unreadable=true;await emitUrl();await act(async()=>latest.home.discardUnreadable());unreadable=false;
  assert.equal(queue.length,0);assert.equal(acknowledgements,3);
  console.log('PASS unreadable intent is retained until confirmed and never clears a newer intent');

  overflow=2;await emitUrl();assert.match(latest.home.error.message,/2 incoming share request/);
  await act(async()=>latest.home.discardUnreadable());assert.equal(latest.home.error,null);
  const later=enqueue(a);await act(async()=>{for(const cb of appListeners)cb('active')});
  assert.equal(latest.handler.generation,later,'later identical share appears on app resume');
  await act(async()=>latest.handler.consume(a,later));
  await act(async()=>tree.unmount());assert.equal(appListeners.size,0);assert.equal(urlListeners.size,0);
  console.log('PASS queue overflow is reported and lifecycle listeners are removed');
})().catch(error=>{oldError(error);process.exitCode=1}).finally(()=>{Module._load=oldLoad;console.error=oldError});
