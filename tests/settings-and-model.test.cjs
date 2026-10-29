const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function load(name, stubs) {
  const filename = path.join(__dirname, '../src/scripts', `${name}.ts`);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(__dirname);
  mod.require = function(request) {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    return Module.prototype.require.call(this, request);
  };
  mod._compile(js, filename);
  return mod.exports;
}

const files = new Map();
let failMove = false;
class FakeFile {
  constructor(...parts) { this.uri = parts.map(p => typeof p === 'string' ? p : p.uri).join('/'); }
  get exists() { return files.has(this.uri); }
  async text() { await delay(1); return files.get(this.uri); }
  async write(value) { await delay(1); files.set(this.uri, value); }
  async move(dest) {
    await delay(1);
    if (failMove) { failMove = false; throw new Error('simulated disk error'); }
    files.set(dest.uri, files.get(this.uri)); files.delete(this.uri); this.uri = dest.uri;
  }
  delete() { files.delete(this.uri); }
}
const settings = load('settings', {
  'expo-file-system': { File: FakeFile, Paths: { document: { uri: 'doc' } } },
  './deviceCores': { suggestCoreLevel: () => 4 },
  '@/modules/AudioProcessorModule': { atomicReplaceFile: async (src,dst) => {
    await delay(1); if (failMove) { failMove=false; throw new Error('simulated disk error'); }
    files.set(dst, files.get(src)); files.delete(src); return dst;
  } },
});

(async () => {
  const defaults = await settings.getSettings(); defaults.attenLimDb = 99;
  assert.equal((await settings.getSettings()).attenLimDb, 0, 'defaults must not be shared by reference');
  await Promise.all([
    settings.updateSettings({ runtime: 'cpu' }),
    settings.updateSettings({ attenPreset: 'strong' }),
    ...Array.from({length: 30}, () => settings.incrementDenoiseCount()),
  ]);
  let saved = await settings.getSettings();
  assert.equal(saved.runtime, 'cpu'); assert.equal(saved.attenPreset, 'strong');
  assert.equal(saved.attenLimDb, 5); assert.equal(saved.denoiseCount, 30);
  console.log('PASS settings concurrent mutations, counters and independent defaults');
  failMove = true;
  const warn = console.error; console.error = () => {};
  try { await assert.rejects(() => settings.updateSettings({ runtime: 'nnapi' }), /Could not save settings/); }
  finally { console.error = warn; }
  assert.equal((await settings.getSettings()).runtime, 'cpu', 'failed write must leave old settings intact');
  await settings.updateSettings({ runtime: 'xnnpack' });
  assert.equal((await settings.getSettings()).runtime, 'xnnpack', 'queue must recover after write failure');
  assert.ok(![...files.keys()].some(key => key.endsWith('.tmp')));
  console.log('PASS failed settings write preserves old data and does not poison queue');

  let config = { runtime: 'cpu', coreMode: 4 };
  const events = [];
  let count = 0;
  class FakeDenoiser {
    constructor() { this.id = ++count; this.lastEngine = 'fake'; }
    async loadModel(_uri, runtime) { this.runtime = runtime; events.push(`load-${this.id}-${runtime}`); await delay(2); }
    async release() { events.push(`release-start-${this.id}`); await delay(5); events.push(`release-end-${this.id}`); }
  }
  const singleton = load('denoiserSingleton', {
    'expo-asset': { Asset: { fromModule: () => ({ localUri:'file:///model.ort', downloadAsync: async () => {} }) } },
    '@/assets/model/denoiser_model.ort': 1,
    './Denoiser': { DeepFilterNet: FakeDenoiser },
    './settings': { getSettings: async () => ({...config}), resolveCoreLevel: () => 4 },
  });
  const [first, same] = await Promise.all([singleton.getDenoiser(), singleton.getDenoiser()]);
  assert.equal(first, same); assert.equal(count, 1, 'same config must not load two models');
  singleton.beginRun(); config.runtime = 'nnapi';
  await singleton.resetDenoiser();
  const during = await singleton.getDenoiser();
  assert.equal(during, first); assert.ok(!events.includes('release-start-1'), 'active model must not be released');
  singleton.endRun();
  const after = await singleton.getDenoiser();
  assert.notEqual(after, first); assert.equal(after.runtime, 'nnapi');
  assert.ok(events.indexOf('release-end-1') < events.indexOf('load-2-nnapi'), 'release must finish before new model load');
  console.log('PASS shared model load/reset is serialized and deferred during active runs');

  const actual = JSON.parse(fs.readFileSync(path.join(__dirname,'../assets/model/model_metadata.json'),'utf8'));
  const reordered = { ...actual, inputs: [actual.inputs[0], ...actual.inputs.slice(1).reverse()],
    outputs: [actual.outputs[0], ...actual.outputs.slice(1).reverse()] };
  class Tensor { constructor(_type,data,shape) { this.data=data; this.dims=shape; } }
  let feedNames = [];
  const session = {
    async run(feeds) {
      feedNames = Object.keys(feeds);
      const result = { enhanced_audio_frame: { data:new Float32Array(actual.hop_size).fill(0.25) } };
      actual.state_input_names.forEach((name,index) => {
        const meta = actual.inputs.find(input => input.name === name);
        const length = meta.shape.reduce((a,b)=>a*b,1);
        result[`new_${name}`] = { data:new Float32Array(length).fill(index+1) };
      });
      return result;
    }, async release() {},
  };
  const model = load('Denoiser', {
    '@/assets/model/model_metadata.json': reordered,
    'onnxruntime-react-native': { Tensor, InferenceSession: { create: async () => session } },
    './alignedDenoiseStream': load('alignedDenoiseStream', {}),
  });
  const denoiser = new model.DeepFilterNet();
  await denoiser.loadModel('file:///model.ort','cpu',4);
  const stream = denoiser.createStream(0);
  const erb = stream.stateBuffers[actual.state_input_names.indexOf('erb_norm_state')];
  const band = stream.stateBuffers[actual.state_input_names.indexOf('band_unit_norm_state')];
  assert.equal(erb[0], -60); assert.equal(erb[erb.length - 1], -90);
  assert.ok(Math.abs(band[0] - 0.001) < 1e-9); assert.ok(Math.abs(band[band.length - 1] - 0.0001) < 1e-9);
  const output = await denoiser.processFrame(stream,new Float32Array(actual.hop_size));
  assert.equal(output[0],0.25);
  actual.state_input_names.forEach((name,index) => {
    assert.ok(feedNames.includes(name));
    assert.equal(stream.stateBuffers[index][0],index+1,`state mapping for ${name}`);
  });
  console.log('PASS model normalization initialization and state mapping use correct names');
  session.run = async () => ({enhanced_audio_frame: {data: new Float32Array(actual.hop_size).fill(NaN)}});
  await assert.rejects(() => denoiser.processFrame(stream, new Float32Array(actual.hop_size)), /non-finite/);
  await assert.rejects(() => denoiser.processFrame(stream, Float32Array.from([NaN])), /non-finite/);
  console.log('PASS non-finite model output and inputs are rejected rather than silently saved');
})().catch(error => { console.error(error); process.exitCode = 1; });
