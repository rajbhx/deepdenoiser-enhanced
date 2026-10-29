#!/usr/bin/env node
/*
 * Reproducible, synthetic-data CPU benchmark for the real bundled model.
 * This exercises the JS streaming path on the host; it is NOT an Android or
 * OnePlus benchmark and makes no claims about mobile latency or battery use.
 *
 * Example: NODE_PATH=$HOME/.cache/dd-onnx/node_modules node --expose-gc \
 *   scripts/benchmark-model.cjs --seconds 5 --rounds 3 --threads 4
 * For a before/after comparison, --script-dir may point to a saved copy of
 * Denoiser.ts and alignedDenoiseStream.ts from the baseline revision.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const ort = require('onnxruntime-node');
const root = path.resolve(__dirname, '..');
const metadata = require(path.join(root, 'assets/model/model_metadata.json'));
const options = Object.fromEntries(process.argv.slice(2).map((arg, i, all) =>
  arg.startsWith('--') ? [arg.slice(2), all[i + 1]] : null).filter(Boolean));
const seconds = Number(options.seconds ?? 5);
const rounds = Number(options.rounds ?? 3);
const threads = Number(options.threads ?? 4);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60 ||
    !Number.isInteger(rounds) || rounds < 1 || rounds > 10 ||
    ![2, 4, 8].includes(threads)) {
  throw new Error('Use 1–60 seconds, 1–10 rounds, and 2/4/8 threads.');
}
const scriptDir = path.resolve(options['script-dir'] || path.join(root, 'src/scripts'));
function load(name, stubs = {}) {
  const filename = path.join(scriptDir, `${name}.ts`);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(root);
  mod.require = function (request) {
    return Object.hasOwn(stubs, request) ? stubs[request] : Module.prototype.require.call(this, request);
  };
  mod._compile(js, filename);
  return mod.exports;
}
const aligned = load('alignedDenoiseStream');
const { DeepFilterNet } = load('Denoiser', {
  '@/assets/model/model_metadata.json': metadata,
  'onnxruntime-react-native': ort,
  './alignedDenoiseStream': aligned,
});
// Deterministic noisy synthetic input: no recordings or private data involved.
let random = 123456789;
const input = Float32Array.from({ length: seconds * 48000 + 17 }, (_, i) => {
  random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
  return 0.12 * Math.sin(i * 0.031) + 0.025 * ((random >>> 0) / 0x80000000 - 1);
});
const digest = array => crypto.createHash('sha256')
  .update(Buffer.from(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
(async () => {
  const model = new DeepFilterNet();
  await model.loadModel(path.join(root, 'assets/model/denoiser_model.ort'), 'cpu', threads);
  await model.denoise(input.subarray(0, 48000), undefined, 10); // warm up kernels
  const results = [];
  for (let i = 0; i < rounds; i++) {
    if (global.gc) global.gc();
    const memoryBefore = process.memoryUsage();
    const started = process.hrtime.bigint();
    const out = await model.denoise(input, undefined, 10);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const memoryAfter = process.memoryUsage();
    if (out.length !== input.length || out.some(v => !Number.isFinite(v))) {
      throw new Error('Benchmark output is not finite and length-preserving.');
    }
    results.push({ elapsedMs: Math.round(elapsedMs), realtimeFactor: +(elapsedMs / (input.length / 48)).toFixed(3),
      rssBeforeMiB: +(memoryBefore.rss / 1048576).toFixed(1), rssAfterMiB: +(memoryAfter.rss / 1048576).toFixed(1),
      externalBeforeMiB: +(memoryBefore.external / 1048576).toFixed(1), externalAfterMiB: +(memoryAfter.external / 1048576).toFixed(1),
      sha256: digest(out) });
  }
  if (new Set(results.map(r => r.sha256)).size !== 1) throw new Error('Inconsistent benchmark output.');
  console.log(JSON.stringify({ kind: 'synthetic-host-cpu-not-android', node: process.version, platform: process.platform,
    arch: process.arch, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, threads, seconds, rounds,
    scriptDir, inputSha256: digest(input), results }, null, 2));
  await model.release();
})().catch(error => { console.error(error); process.exitCode = 1; });
