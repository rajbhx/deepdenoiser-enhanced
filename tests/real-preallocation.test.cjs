/* Real bundled ONNX CPU model: compare conventional results with the reusable
 * tensor path. Node ORT writes to provided tensors but returns copied Tensor
 * wrappers; the small adapter below verifies the bytes and returns the supplied
 * tensors, as the inspected React Native binding does. This is not a device
 * test and does not certify Android provider/driver behavior. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const ort = require('onnxruntime-node');
const metadata = require('../assets/model/model_metadata.json');
function load(name, stubs = {}) {
  const filename = path.join(__dirname, '../src/scripts', name + '.ts');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(__dirname);
  mod.require = function (request) {
    return Object.hasOwn(stubs, request) ? stubs[request] : Module.prototype.require.call(this, request);
  };
  mod._compile(js, filename); return mod.exports;
}
const aligned = load('alignedDenoiseStream');
let verifiedReuseCalls = 0;
const rnLikeOrt = { Tensor: ort.Tensor, InferenceSession: { create: async (...args) => {
  const session = await ort.InferenceSession.create(...args);
  return {
    async run(feeds, fetches) {
      const result = fetches ? await session.run(feeds, fetches) : await session.run(feeds);
      if (!fetches) return result;
      for (const [name, tensor] of Object.entries(fetches)) {
        const a = Buffer.from(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength);
        const b = Buffer.from(result[name].data.buffer, result[name].data.byteOffset, result[name].data.byteLength);
        assert.ok(a.equals(b), `Node preallocated bytes match returned bytes: ${name}`);
      }
      verifiedReuseCalls++;
      return fetches;
    },
    release: () => session.release(),
  };
} } };
function makeModel(runtime) {
  const { DeepFilterNet } = load('Denoiser', {
    '@/assets/model/model_metadata.json': metadata,
    'onnxruntime-react-native': runtime,
    './alignedDenoiseStream': aligned,
  });
  return new DeepFilterNet();
}
function bytes(array) { return Buffer.from(array.buffer, array.byteOffset, array.byteLength); }
async function run(model, input, strength, sizes) {
  const state = model.createStream(strength);
  const stream = new aligned.AlignedDenoiseStream(metadata.hop_size, metadata.algorithmic_delay_samples,
    (frame, output) => model.processFrame(state, frame, output));
  const result = new Float32Array(input.length);
  let position = 0, outputPosition = 0, n = 0;
  while (position < input.length) {
    const length = Math.min(sizes[n++ % sizes.length], input.length - position);
    const chunk = await stream.push(input.subarray(position, position + length));
    result.set(chunk, outputPosition); outputPosition += chunk.length; position += length;
  }
  const tail = await stream.finish(); result.set(tail, outputPosition); outputPosition += tail.length;
  assert.equal(outputPosition, input.length);
  return { result, state };
}
(async () => {
  const standard = makeModel(ort), reused = makeModel(rnLikeOrt);
  const modelPath = path.join(__dirname, '../assets/model/denoiser_model.ort');
  await standard.loadModel(modelPath, 'cpu', 4); await reused.loadModel(modelPath, 'cpu', 4);
  const signal = Float32Array.from({length: 48000 * 2 + 17}, (_, i) =>
    0.15 * Math.sin(i * 0.037) + 0.03 * Math.cos(i * 0.119));
  const silence = new Float32Array(48000 * 4 + 13);
  for (const [input, strength] of [[signal, 0], [signal, 17], [signal, 40], [silence, 0]]) {
    const a = await run(standard, input, strength, [96000, 17]);
    const b = await run(reused, input, strength, [1, 1200, 479, 5003, 72]);
    assert.equal(a.state.outputReuse, 'disabled', 'Node runtime returns distinct wrappers and falls back');
    assert.equal(b.state.outputReuse, 'enabled', 'adapter exercises reusable outputs');
    assert.ok(bytes(a.result).equals(bytes(b.result)), `real-model output differs at strength ${strength}`);
    for (let i = 0; i < a.state.stateBuffers.length; i++) {
      assert.ok(bytes(a.state.stateBuffers[i]).equals(bytes(b.state.stateBuffers[i])), `real recurrent state differs: ${i}`);
    }
    assert.ok(b.result.every(Number.isFinite));
  }
  assert.ok(verifiedReuseCalls > 900, 'repeated frame reuse exercised');
  await standard.release(); await reused.release();
  console.log(`PASS real model: ${verifiedReuseCalls} reusable frames match conventional CPU outputs and recurrent state bit-for-bit`);
})().catch(error => { console.error(error); process.exitCode = 1; });
