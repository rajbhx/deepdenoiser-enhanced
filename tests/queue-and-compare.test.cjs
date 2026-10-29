const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function load(name) {
  const filename = path.join(__dirname, '../src/scripts', name + '.ts');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module); mod.filename = filename; mod._compile(js, filename); return mod.exports;
}
const { runSequentialQueue, ProcessingCancelled } = load('batchQueue');
const { switchPlayback, togglePlayback } = load('comparePlayback');
(async () => {
  let concurrent = 0, maxConcurrent = 0;
  const events = [];
  await runSequentialQueue(['a','bad','c'], {cancelled:false}, async (item) => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 4));
    concurrent--;
    if (item === 'bad') throw new Error('bad file');
    return item.toUpperCase();
  }, e => events.push(e));
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(events.map(e => `${e.type}:${e.index}`), ['started:0','completed:0','started:1','failed:1','started:2','completed:2']);
  assert.equal(events[3].error.message, 'bad file');
  console.log('PASS queue is sequential and continues after an individual failure');

  const cancelled = {cancelled:false}, stoppedEvents = [];
  await runSequentialQueue([1,2,3], cancelled, async (_item, index, token) => {
    if (index === 0) { token.cancelled = true; throw new ProcessingCancelled(); }
    assert.fail('a later item must not start');
  }, e => stoppedEvents.push(e));
  assert.deepEqual(stoppedEvents.map(e => `${e.type}:${e.index}`), ['started:0','cancelled:0','cancelled:1','cancelled:2']);
  console.log('PASS cancellation stops later files and marks them stopped');

  const commitToken = {cancelled:false}, commitEvents = [];
  await runSequentialQueue([1,2], commitToken, async (_item, _index, token) => {
    token.cancelled = true; return 'durable-output';
  }, e => commitEvents.push(e));
  assert.deepEqual(commitEvents.map(e => e.type), ['started','completed','cancelled']);
  console.log('PASS committed output remains successful when cancellation arrives late');

  const calls = [];
  const source = { currentTime: 16.2, duration: 100, playing: true, pause(){ calls.push('pause'); }, play(){ calls.push('resume-source'); }, async seekTo(){} };
  const target = { currentTime: 0, duration: 12, playing: false, pause(){}, play(){ calls.push('play-target'); }, async seekTo(t){ calls.push(`seek:${t}`); } };
  await switchPlayback(source, target);
  assert.deepEqual(calls, ['pause','seek:12','play-target']);
  calls.length = 0; source.playing = false; target.duration = 100;
  await switchPlayback(source, target);
  assert.deepEqual(calls, ['pause','seek:16.2']);
  calls.length = 0; source.playing = true;
  target.seekTo = async () => { throw new Error('seek failure'); };
  await assert.rejects(() => switchPlayback(source, target), /seek failure/);
  assert.deepEqual(calls, ['pause','resume-source']);
  console.log('PASS A/B switching preserves play/pause and time, clamps, and recovers on seek failure');
  calls.length = 0; target.currentTime = 100; target.duration = 100; target.playing = false;
  target.seekTo = async (value) => calls.push(`seek:${value}`);
  await togglePlayback(target);
  assert.deepEqual(calls, ['seek:0','play-target']);
  console.log('PASS A/B playback restarts at the beginning after reaching the end');
})().catch(e => { console.error(e); process.exitCode = 1; });
