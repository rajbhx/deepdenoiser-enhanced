const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const metadata = require('../assets/model/model_metadata.json');

function loadFile(filename, stubs = {}) {
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(__dirname);
  mod.require = function (request) {
    return Object.hasOwn(stubs, request) ? stubs[request] : Module.prototype.require.call(this, request);
  };
  mod._compile(js, filename); return mod.exports;
}
const script = name => path.join(__dirname, '../src/scripts', name + '.ts');
const Current = loadFile(script('alignedDenoiseStream')).AlignedDenoiseStream;
const Reference = loadFile(path.join(__dirname, 'fixtures/alignedDenoiseStream-reference.ts')).AlignedDenoiseStream;
let random = 9123457;
const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
function processing(hop, delay, useScratch) {
  const history = new Float32Array(Math.max(1, delay));
  let pos = 0, call = 0, firstScratch;
  const fn = async (frame, scratch) => {
    if (useScratch) {
      assert.ok(scratch instanceof Float32Array && scratch.length === hop);
      if (firstScratch) assert.equal(scratch, firstScratch, 'output scratch is owned and reused by one stream');
      firstScratch = scratch;
    }
    const out = useScratch ? scratch : new Float32Array(hop);
    for (let i = 0; i < hop; i++) {
      let delayed = frame[i];
      if (delay) { delayed = history[pos]; history[pos] = frame[i]; pos = (pos + 1) % delay; }
      out[i] = delayed * (call % 2 ? 0.75 : 0.5);
    }
    call++;
    return out;
  };
  fn.calls = () => call;
  return fn;
}
async function compareStreams(hop, delay, length, sizes) {
  const input = Float32Array.from({length}, (_, i) => ((next() % 20001) - 10000) / 10000 + i * 1e-8);
  const refFn = processing(hop, delay, false), newFn = processing(hop, delay, true);
  const ref = new Reference(hop, delay, refFn), current = new Current(hop, delay, newFn);
  let offset = 0, sizeIndex = 0, total = 0;
  while (offset < length) {
    const n = Math.min(length - offset, sizes[sizeIndex++ % sizes.length]);
    const chunk = input.subarray(offset, offset + n);
    const a = await ref.push(chunk), b = await current.push(chunk);
    assert.deepEqual(b, a, `push mismatch (hop=${hop}, delay=${delay}, length=${length}, offset=${offset})`);
    offset += n; total += b.length;
  }
  assert.deepEqual(await ref.push(new Float32Array(0)), await current.push(new Float32Array(0)));
  const a = await ref.finish(), b = await current.finish();
  assert.deepEqual(b, a, `tail mismatch (hop=${hop}, delay=${delay}, length=${length})`);
  total += b.length;
  assert.equal(total, length, 'exact original length');
  assert.equal(newFn.calls(), refFn.calls(), 'same model frames and ordering');
  await assert.rejects(() => current.push(new Float32Array(1)), /finished/);
  await assert.rejects(() => current.finish(), /finished/);
}
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
function makeSession(behavior) {
  let standardCalls = 0, reusableCalls = 0;
  const feedIdentities = [];
  return {
    get standardCalls() { return standardCalls; },
    get reusableCalls() { return reusableCalls; },
    feedIdentities,
    async run(feeds, fetches) {
      feedIdentities.push(feeds);
      if (fetches) reusableCalls++; else standardCalls++;
      if (fetches && behavior === 'throw-after-probe' && reusableCalls > 1) {
        fetches.enhanced_audio_frame.data.fill(NaN); // do not touch inputs
        throw Error('runtime rejected preallocated output');
      }
      const output = {};
      for (const spec of metadata.outputs) {
        const data = new Float32Array(spec.shape.reduce((a, b) => a * b, 1));
        if (spec.name === 'enhanced_audio_frame') {
          for (let i = 0; i < data.length; i++) data[i] = feeds.input_frame.data[i] * 0.5;
        } else {
          const input = feeds[spec.name.replace(/^new_/, '')].data;
          for (let i = 0; i < data.length; i++) data[i] = input[i] * 0.75 + 0.00001;
        }
        if (fetches && behavior !== 'ignore') {
          fetches[spec.name].data.set(data);
          output[spec.name] = fetches[spec.name];
        } else output[spec.name] = new Tensor('float32', data, spec.shape);
      }
      if (fetches && behavior === 'mismatch') output.enhanced_audio_frame.data[0] += 1;
      if (fetches && behavior === 'identity-lost' && reusableCalls > 1) {
        return Object.fromEntries(Object.entries(output).map(([name, value]) =>
          [name, new Tensor('float32', new Float32Array(value.data), value.dims)]));
      }
      return output;
    },
    async release() {},
  };
}
async function makeModel(behavior) {
  const session = makeSession(behavior);
  const { DeepFilterNet } = loadFile(script('Denoiser'), {
    '@/assets/model/model_metadata.json': metadata,
    'onnxruntime-react-native': { Tensor, InferenceSession: { create: async () => session } },
    './alignedDenoiseStream': { AlignedDenoiseStream: Current },
  });
  const model = new DeepFilterNet(); await model.loadModel('synthetic', 'cpu', 4);
  return { model, session };
}
async function compareReusable(behavior, expectedMode) {
  const baseline = await makeModel('ignore'), candidate = await makeModel(behavior);
  const a = baseline.model.createStream(17), b = candidate.model.createStream(17);
  const a2 = baseline.model.createStream(0), b2 = candidate.model.createStream(0);
  assert.notEqual(b.feeds, b2.feeds, 'streams never share feeds');
  assert.notEqual(b.reusableOutputs, b2.reusableOutputs, 'streams never share output buffers');
  for (let frame = 0; frame < 9; frame++) {
    const input = Float32Array.from({length: metadata.hop_size}, (_, i) => Math.sin((frame * 512 + i) * 0.013) * 0.2);
    assert.deepEqual(await candidate.model.processFrame(b, input), await baseline.model.processFrame(a, input));
    if (frame === 3) assert.deepEqual(await candidate.model.processFrame(b2, input), await baseline.model.processFrame(a2, input));
  }
  for (let i = 0; i < a.stateBuffers.length; i++) assert.deepEqual(b.stateBuffers[i], a.stateBuffers[i]);
  assert.equal(b.outputReuse, expectedMode);
  assert.ok(candidate.session.feedIdentities.filter(x => x === b.feeds).length >= 9, 'feed map remains stable');
  if (behavior === 'accept') assert.ok(candidate.session.reusableCalls > 9, 'reused after successful verification');
  if (behavior === 'mismatch' || behavior === 'ignore') assert.equal(candidate.session.reusableCalls, 2, 'failed probes are not repeated per stream');
  if (behavior === 'throw-after-probe' || behavior === 'identity-lost') assert.equal(candidate.session.reusableCalls, 3, 'fallback after an enabled-path failure');
}
(async () => {
  for (const hop of [1, 4, 17, 512]) {
    for (const delay of [0, 1, hop, hop + 3, hop * 3 + 7]) {
      for (const length of [0, 1, hop - 1, hop, hop + 1, hop * 5 + 11]) {
        await compareStreams(hop, delay, length, [1, hop + 2, 3, hop * 2 + 1, 7]);
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    const hop = 2 + next() % 128, delay = next() % (hop * 4 + 1), length = next() % 5000;
    await compareStreams(hop, delay, length, [1 + next() % 300, 1 + next() % 500, 1 + next() % 20]);
  }
  console.log('PASS allocation-bounded framing matches the prior implementation across arbitrary seams, delays, tails and empty inputs');
  for (const [behavior, mode] of [['accept','enabled'], ['ignore','disabled'], ['mismatch','disabled'],
    ['throw-after-probe','disabled'], ['identity-lost','disabled']]) await compareReusable(behavior, mode);
  console.log('PASS reusable output verification, independent stream state, and safe fallback preserve model output');
  const alternate = {
    hop_size: 4, algorithmic_delay_samples: 0,
    inputs: [{name:'input_frame',shape:[4]}, {name:'states',shape:[2]}, {name:'atten_lim_db',shape:[1]}],
    outputs: [{name:'enhanced',shape:[4],type:'tensor(float)'}, {name:'new_states',shape:[2],type:'tensor(float)'}],
    state_input_names: ['states'],
  };
  const singleSession = {async run(feeds, fetches) {
    const value = feeds.atten_lim_db.data[0];
    const values = {enhanced:new Float32Array(4).fill(value), new_states:new Float32Array(2).fill(feeds.states.data[0]+1)};
    return Object.fromEntries(alternate.outputs.map(spec => {
      const tensor = fetches?.[spec.name] || new Tensor('float32',new Float32Array(spec.shape[0]),spec.shape);
      tensor.data.set(values[spec.name]); return [spec.name,tensor];
    }));
  }, async release() {}};
  const {DeepFilterNet: SingleModel} = loadFile(script('Denoiser'), {
    '@/assets/model/model_metadata.json': alternate,
    'onnxruntime-react-native': {Tensor,InferenceSession:{create:async()=>singleSession}},
    './alignedDenoiseStream': {AlignedDenoiseStream:Current},
  });
  const single = new SingleModel(); await single.loadModel('synthetic','cpu',4);
  const singleState = single.createStream(3);
  assert.equal((await single.processFrame(singleState,new Float32Array(4)))[0],3);
  single.setStreamAttenLimDb(singleState,11);
  assert.equal((await single.processFrame(singleState,new Float32Array(4)))[0],11);
  assert.equal(singleState.stateBuffers[0][0],2);
  assert.equal(singleState.outputReuse,'enabled');
  console.log('PASS cached feeds preserve single-state and mutable native-strength model support');
  const stream = new Current(4, 0, async () => new Float32Array(3));
  await assert.rejects(() => stream.push(new Float32Array(4)), /frame size/);
  console.log('PASS malformed model frame still fails closed');
})().catch(error => { console.error(error); process.exitCode = 1; });
