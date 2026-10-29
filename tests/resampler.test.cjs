const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.join(__dirname, '../src/scripts/resampler.ts');
const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = new Module(filename, module);
mod.filename = filename;
mod._compile(js, filename);
const { StreamingResampler } = mod.exports;
function convert(input, from, to, sizes) {
  const resampler = new StreamingResampler(from, to);
  const out = [];
  let offset = 0, j = 0;
  while (offset < input.length) {
    const n = sizes[j++ % sizes.length];
    out.push(...resampler.push(input.subarray(offset, offset + n)));
    offset += n;
  }
  out.push(...resampler.finish());
  assert.equal(resampler.finish().length, 0, 'finish must be idempotent');
  return out;
}
for (const [from, to] of [[44100, 48000], [48000, 44100], [96000, 48000], [48000, 48000], [8000, 48000]]) {
  const input = Float32Array.from({length: 10009}, (_, i) => 0.6 * Math.sin(i * 0.129) + 0.1 * Math.cos(i * 0.011));
  const whole = convert(input, from, to, [input.length]);
  const chunked = convert(input, from, to, [1, 2, 9, 357, 17, 1024, 3, 701]);
  assert.equal(chunked.length, Math.ceil(input.length * to / from), `output length ${from}->${to}`);
  assert.equal(chunked.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(chunked[i] - whole[i]) < 1e-6, `chunk seam at ${i}`);
  assert.ok(chunked.every(Number.isFinite), 'all samples finite');
  console.log(`PASS streaming ${from} -> ${to}: ${chunked.length} samples, independent of chunk boundaries`);
}
const rate = 96000;
const pass = Float32Array.from({length: rate}, (_, i) => Math.sin(2 * Math.PI * 10000 * i / rate));
const stop = Float32Array.from({length: rate}, (_, i) => Math.sin(2 * Math.PI * 35000 * i / rate));
const rms = (x) => Math.sqrt(x.slice(1000).reduce((sum, v) => sum + v*v, 0) / (x.length - 1000));
const passed = rms(convert(pass, rate, 48000, [791]));
const rejected = rms(convert(stop, rate, 48000, [791]));
assert.ok(passed > 0.5, `10 kHz passband too quiet: ${passed}`);
assert.ok(rejected < passed * 0.12, `35 kHz alias rejection too weak: ${rejected}/${passed}`);
assert.throws(() => new StreamingResampler(0, 48000), /positive/);
console.log(`PASS downsample anti-aliasing: 35 kHz RMS ${(rejected / passed).toFixed(4)} of 10 kHz`);
