/**
 * Real-model CPU regression for the aligned processing pipeline.
 * Runs the checked-out Denoiser.ts, processMedia.ts and writePCMChunk with
 * the actual bundled model and ONNX Runtime Node 1.24.3 CPU. Android decode,
 * storage, WAV wrapping, and the caches are substituted with test doubles.
 * All test files are written under a temporary directory and then removed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const repo = path.resolve(__dirname, '..');
const ts = require(path.join(repo, 'node_modules/typescript'));
const ort = require('onnxruntime-node');
const metadata = require(path.join(repo, 'assets/model/model_metadata.json'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deepdenoiser-model-audit-'));
fs.mkdirSync(path.join(work, 'cache'));
fs.mkdirSync(path.join(work, 'out'));

function load(name, stubs = {}) {
  const filename = path.join(repo, 'src/scripts', name + '.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = function(request) {
    return Object.hasOwn(stubs, request) ? stubs[request] : Module.prototype.require.call(this, request);
  };
  mod._compile(js, filename);
  return mod.exports;
}

class File {
  constructor(...parts) { this.uri = path.join(...parts.map(p => typeof p === 'string' ? p : p.uri)); }
  get exists() { return fs.existsSync(this.uri); }
  get size() { return this.exists ? fs.statSync(this.uri).size : 0; }
  get name() { return path.basename(this.uri); }
  delete() { fs.unlinkSync(this.uri); }
  async move(dest) { await fs.promises.rename(this.uri, dest.uri); this.uri = dest.uri; }
  async write(data, options = {}) { await fs.promises.writeFile(this.uri, data, { flag: options.append ? 'a' : 'w' }); }
  open() {
    const fd = fs.openSync(this.uri, 'r');
    return {
      offset: 0,
      readBytes(length) {
        const b = Buffer.alloc(length);
        const read = fs.readSync(fd, b, 0, length, this.offset);
        this.offset += read;
        return new Uint8Array(b.buffer, b.byteOffset, read);
      },
      close() { fs.closeSync(fd); },
    };
  }
}
const filesystem = { File, Paths: { cache: { uri: path.join(work, 'cache') }, document: { uri: path.join(work, 'out') } } };
const format = load('formatHandler', {
  '@/modules/AudioProcessorModule': {}, 'expo-file-system': filesystem, 'expo-media-library': {},
  'react-native': { Platform: { OS: 'android', Version: 33 } },
  './analytics': {}, './silenceTrim': {}, './resampler': load('resampler'),
});
let serial = 0;
format.decodeToPCMFile = async (input, uri) => {
  fs.copyFileSync(input.uri, uri);
  return { file: new File(uri), sampleRate: 48000 };
};
format.PCMtoWav = async file => {
  const output = new File(work, 'cache', `wrapped_${serial++}.pcm`);
  fs.copyFileSync(file.uri, output.uri);
  return { file: output, trimmed: false, trimStartUs: 0, trimEndUs: 0 };
};
const cache = {
  buildCacheKey: () => '', buildDecodeKey: () => '', buildDenoiseKey: () => '',
  lookupCachedOutput: async () => null, lookupDecodedPCM: async () => null, lookupDenoisedPCM: async () => null,
  storeCachedOutput: async () => {}, storeDecodedPCM: async () => {}, storeDenoisedPCM: async () => {},
  pruneRebuildableCache: async () => {},
  stagePcmPath: prefix => `${prefix}_${serial++}.pcm`,
  placeOutput: async (file, name) => {
    const output = new File(work, 'out', `${serial++}_${name}`);
    await file.move(output);
    return output;
  },
};
const aligned = load('alignedDenoiseStream');
const { DeepFilterNet } = load('Denoiser', {
  '@/assets/model/model_metadata.json': metadata, 'onnxruntime-react-native': ort,
  './alignedDenoiseStream': aligned,
});

function correlation(input, output, lag) {
  let xy = 0, xx = 0, yy = 0;
  const count = input.length / 2;
  for (let i = 5000; i < count - 5000; i++) {
    const x = input.readInt16LE(i * 2);
    const y = output.readInt16LE((i + lag) * 2);
    xy += x * y; xx += x * x; yy += y * y;
  }
  return xy / Math.sqrt(xx * yy);
}

(async () => {
  const model = new DeepFilterNet();
  try {
    await model.loadModel(path.join(repo, 'assets/model/denoiser_model.ort'), 'cpu', 4);
    const queue = load('batchQueue');
    const pipeline = load('processMedia', {
      '@/assets/model/model_metadata.json': metadata, 'expo-file-system': filesystem,
      './denoiserSingleton': { beginRun() {}, endRun() {}, getDenoiser: async () => model },
      './denoiseCache': cache, './formatHandler': format, './batchQueue': queue,
      './diagnostics': { recordDiagnostic() {}, recordDiagnosticError() {} },
      './alignedDenoiseStream': aligned,
    });
    const input = new File(work, 'input.pcm');
    const samples = 96017;
    const source = Buffer.alloc(samples * 2);
    let seed = 12345;
    for (let i = 0; i < samples; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      source.writeInt16LE(Math.round(((seed / 4294967295) * 2 - 1) * 4000), i * 2);
    }
    fs.writeFileSync(input.uri, source);
    const settings = {
      attenLimDb: 0, normalize: { toggle: false, targetRMS: -14, maxPeakDb: -1 },
      silenceTrim: { enabled: false, mode: 'auto', thresholdDb: -40, minSilenceMs: 500 },
    };
    const outputs = [];
    let nonfiniteSamples = 0;
    const originalProcessFrame = model.processFrame.bind(model);
    model.processFrame = async (...args) => {
      const output = await originalProcessFrame(...args);
      const offset = args[3] || 0;
      const frame = args[2] ? args[2].subarray(offset, offset + metadata.hop_size) : output;
      for (const sample of frame) if (!Number.isFinite(sample)) nonfiniteSamples++;
      return output;
    };
    for (const strength of [0, 40]) {
      settings.attenLimDb = strength;
      nonfiniteSamples = 0;
      const result = await pipeline.processMedia(input, 'input.wav', false, settings, { cancelled: false }, () => {});
      const output = fs.readFileSync(result.file.uri);
      assert.equal(output.length, source.length);
      let leading = 0;
      while (leading < samples && output.readInt16LE(leading * 2) === 0) leading++;
      console.log(`strength=${strength}: ${nonfiniteSamples} non-finite model samples (including priming), ${output.length / 2} saved samples; ${leading} leading zeros (${(leading / 48).toFixed(2)} ms)`);
      assert.equal(nonfiniteSamples, 0);
      outputs.push(output);
    }
    console.log('0 dB and 40 dB outputs byte-identical:', outputs[0].equals(outputs[1]));
    assert.ok(!outputs[0].equals(outputs[1]), 'strength must affect the bundled model');
    const lags = [0, 512, 960, 1024, 1536, 2048];
    const wetCorrelations = lags.map(lag => [lag, correlation(source, outputs[0], lag)]);
    console.log('0 dB wet-only correlations:', wetCorrelations.map(([lag, r]) => `${lag}: ${r.toFixed(4)}`).join(', '));
    assert.equal(wetCorrelations.reduce((a,b) => Math.abs(b[1]) > Math.abs(a[1]) ? b : a)[0], 0, 'wet output must be aligned too');
    const correlations = lags.map(lag => [lag, correlation(source, outputs[1], lag)]);
    console.log('input/output correlation at candidate lags:', correlations.map(([lag, r]) => `${lag}: ${r.toFixed(4)}`).join(', '));
    const best = correlations.reduce((a, b) => Math.abs(b[1]) > Math.abs(a[1]) ? b : a);
    console.log(`largest candidate lag: ${best[0]} samples (${(best[0] / 48).toFixed(2)} ms)`);
    assert.equal(best[0], 0, 'output must be aligned with the original');
    let lastWorst = 0;
    for (let i = samples - 1024; i < samples; i++) {
      lastWorst = Math.max(lastWorst, Math.abs(source.readInt16LE(i * 2) - outputs[1].readInt16LE(i * 2)));
    }
    assert.ok(lastWorst <= 60, `40 dB dry mix must retain the final samples (max error ${lastWorst})`);
    const s = model.createStream(0);
    for (let i = 0; i < 3100; i++) await model.processFrame(s, new Float32Array(metadata.hop_size));
    const unit = s.stateBuffers[metadata.state_input_names.indexOf('band_unit_norm_state')];
    assert.ok(unit.every(v => Number.isFinite(v) && v >= 0.99e-12));
    const afterSilence = await model.processFrame(s, new Float32Array(metadata.hop_size).fill(0.1));
    assert.ok(afterSilence.every(Number.isFinite), 'audio after prolonged silence must stay finite');
    console.log('PASS real bundled model: alignment, final samples, strength, finite startup and 33 seconds silence');
  } finally {
    await model.release();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
