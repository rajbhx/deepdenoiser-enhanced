/* Compare the optimized frame path against the exact 2.0.3 implementation.
 * This is a deterministic host regression, not an Android device test. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const metadata = require('../assets/model/model_metadata.json');

class Tensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}
function session(mode) {
  let reusableCalls = 0;
  return {
    async run(feeds, fetches) {
      if (fetches && ++reusableCalls > 1 && mode === 'throw-after-probe') {
        fetches.enhanced_audio_frame.data.fill(NaN);
        throw Error('preallocated output rejected');
      }
      const output = {};
      for (const spec of metadata.outputs) {
        const length = spec.shape.reduce((a, b) => a * b, 1);
        const data = new Float32Array(length);
        if (spec.name === 'enhanced_audio_frame') {
          const state = feeds.erb_norm_state.data[0];
          for (let i = 0; i < length; i++) data[i] = feeds.input_frame.data[i] * 0.75 + state * 0.00001;
        } else {
          const prior = feeds[spec.name.replace(/^new_/, '')].data;
          for (let i = 0; i < length; i++) data[i] = prior[i] * 0.999 + 0.000001;
        }
        if (fetches && mode !== 'ignore') {
          fetches[spec.name].data.set(data);
          output[spec.name] = fetches[spec.name];
        } else {
          output[spec.name] = new Tensor('float32', data, spec.shape);
        }
      }
      return output;
    },
    async release() {},
  };
}
function load(filename, mode) {
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(__dirname);
  const stubs = {
    '@/assets/model/model_metadata.json': metadata,
    'onnxruntime-react-native': {Tensor, InferenceSession: {create: async () => session(mode)}},
    './alignedDenoiseStream': {AlignedDenoiseStream: class {}},
  };
  mod.require = function (request) {
    return Object.hasOwn(stubs, request) ? stubs[request] : Module.prototype.require.call(this, request);
  };
  mod._compile(js, filename);
  return mod.exports.DeepFilterNet;
}
const base = path.join(__dirname, 'fixtures/Denoiser-2.0.3-reference.txt');
const current = path.join(__dirname, '../src/scripts/Denoiser.ts');
const bytes = data => Buffer.from(data.buffer, data.byteOffset, data.byteLength);
function equalSamples(a, b, label) {
  assert.ok(bytes(a).equals(bytes(b)), label);
}
function equalState(a, b, frame) {
  assert.equal(a.outputReuse, b.outputReuse, `reuse mode at ${frame}`);
  assert.equal(a.dryDelayIndex, b.dryDelayIndex, `delay index at ${frame}`);
  equalSamples(a.inputFrameData, b.inputFrameData, `input frame at ${frame}`);
  equalSamples(a.dryDelay, b.dryDelay, `dry delay at ${frame}`);
  for (let i = 0; i < a.stateBuffers.length; i++) {
    equalSamples(a.stateBuffers[i], b.stateBuffers[i], `state ${i} at ${frame}`);
  }
}
async function compare(mode) {
  const Old = load(base, mode), New = load(current, mode);
  const oldModel = new Old(), newModel = new New();
  await oldModel.loadModel('mock', 'cpu', 4); await newModel.loadModel('mock', 'cpu', 4);
  const oldState = oldModel.createStream(17.123), newState = newModel.createStream(17.123);
  const lengths = [512, 512, 17, 0, 512, 511, 1, 512, 512, 3, 512, 512];
  for (let index = 0; index < lengths.length; index++) {
    if (index === 3) { oldModel.setStreamAttenLimDb(oldState, 0); newModel.setStreamAttenLimDb(newState, 0); }
    if (index === 5) { oldModel.setStreamAttenLimDb(oldState, 40); newModel.setStreamAttenLimDb(newState, 40); }
    if (index === 7) { oldState.attenLimDbData[0] = 12.345; newState.attenLimDbData[0] = 12.345; }
    if (index === 9) { oldModel.setStreamAttenLimDb(oldState, -0); newModel.setStreamAttenLimDb(newState, -0); }
    const input = Float32Array.from({length: lengths[index]}, (_, i) => Math.sin((index * 512 + i) * 0.013) * 0.2);
    const oldDest = new Float32Array(524).fill(-37), newDest = new Float32Array(524).fill(-37);
    await oldModel.processFrame(oldState, input, oldDest, 6);
    await newModel.processFrame(newState, input, newDest, 6);
    equalSamples(oldDest, newDest, `${mode}: output ${index}`);
    equalState(oldState, newState, `${mode}: ${index}`);
  }
  // Preserve even the legacy clear-first behavior for a caller that passes
  // the stream's own input buffer as its next full frame.
  oldState.inputFrameData.fill(0.25); newState.inputFrameData.fill(0.25);
  const oldOut = await oldModel.processFrame(oldState, oldState.inputFrameData);
  const newOut = await newModel.processFrame(newState, newState.inputFrameData);
  equalSamples(oldOut, newOut, `${mode}: aliased input`);
  equalState(oldState, newState, `${mode}: alias`);
  await assert.rejects(() => oldModel.processFrame(oldState, new Float32Array([NaN])), /non-finite/);
  await assert.rejects(() => newModel.processFrame(newState, new Float32Array([NaN])), /non-finite/);
  await oldModel.release(); await newModel.release();
}
(async () => {
  for (const mode of ['accept', 'ignore', 'throw-after-probe']) await compare(mode);
  console.log('PASS optimized frames match the 2.0.3 reference bit-for-bit across full/short/aliased inputs, strength changes and fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
