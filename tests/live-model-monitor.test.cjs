/* Host checks of actual display analysis and sample alignment; not a device test. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.join(__dirname, '..');
function load(name) {
  const filename = path.join(root, 'src/scripts', `${name}.ts`);
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(js, filename);
  return mod.exports;
}
const { LiveModelMonitor, analyzeSpectrum, compareSpectra, LIVE_SAMPLE_RATE, LIVE_FFT_SIZE, LIVE_PERIOD_SAMPLES, LIVE_COLUMNS, LIVE_BANDS } = load('liveModelMonitor');
const { AlignedDenoiseStream } = load('alignedDenoiseStream');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const equalFloats = (actual, expected, label) => assert.deepEqual(Array.from(actual), Array.from(expected), label);
(async () => {
  const silence = analyzeSpectrum(new Float32Array(LIVE_FFT_SIZE));
  assert.equal(silence.length, LIVE_BANDS); assert.ok(silence.every(v => v === -80));
  const bin = 22, amp = 0.5;
  const signal = Float32Array.from({length: LIVE_FFT_SIZE}, (_, i) => amp * Math.sin(2 * Math.PI * bin * i / LIVE_FFT_SIZE));
  const signalCopy = signal.slice();
  const levels = analyzeSpectrum(signal); equalFloats(signal, signalCopy, 'FFT must not mutate the supplied audio');
  const loudest = Math.max(...levels);
  assert.ok(Math.abs(loudest - 20 * Math.log10(amp)) < 0.1, `fixed-scale sinusoid calibration: ${loudest}`);
  const frequency = bin * LIVE_SAMPLE_RATE / LIVE_FFT_SIZE;
  const band = levels.indexOf(loudest);
  const expectedBand = Math.floor(Math.log(frequency / 90) / Math.log(12000 / 90) * LIVE_BANDS);
  assert.ok(Math.abs(band - expectedBand) <= 1, `tone ${frequency} Hz should appear in its frequency region`);
  assert.throws(() => analyzeSpectrum(new Float32Array(100)), /1024/);
  const identical = compareSpectra(signal, signal, 1);
  assert.ok(identical.change.every(v => v === 0), 'same samples must have no displayed energy change');
  const quieter = Float32Array.from(signal, x => x * 0.1);
  const diff = compareSpectra(signal, quieter, 2);
  assert.ok(diff.change[band] < 0, 'a quieter matching tone is classified as lower energy, not as noise');
  equalFloats(signal, signalCopy, 'comparison must be read-only');
  console.log('PASS frequency display uses actual fixed-scale FFT bands, silence and correctly signed energy changes');

  const original = Float32Array.from({length: LIVE_SAMPLE_RATE * 2}, (_, i) => 0.35 * Math.sin(i * .19) + 0.1 * Math.sin(i * .013));
  async function run(withMonitor) {
    const modelDelay = new Float32Array(1536); let position = 0, modelCalls = 0;
    const monitor = withMonitor ? new LiveModelMonitor() : null;
    const stream = new AlignedDenoiseStream(512, 1536, async frame => {
      modelCalls++; monitor?.noteModelFrame();
      const result = new Float32Array(512);
      for (let i = 0; i < result.length; i++) { result[i] = modelDelay[position]; modelDelay[position] = frame[i]; position = (position + 1) % modelDelay.length; }
      return result;
    });
    const output = [];
    for (let offset = 0; offset < original.length; offset += 1920) {
      const part = original.slice(offset, offset + 1920); const copy = part.slice();
      const cleaned = await stream.push(part); output.push(...cleaned);
      monitor?.observe(part, cleaned, true); equalFloats(part, copy, 'monitor must not alter a captured chunk');
      if (monitor) await tick();
    }
    output.push(...await stream.finish());
    const snapshot = monitor?.snapshot();
    monitor?.dispose();
    return {output, snapshot, modelCalls};
  }
  const plain = await run(false), observed = await run(true);
  assert.deepEqual(observed.output, plain.output, 'observation must not change any output sample');
  assert.deepEqual(observed.output, Array.from(original), 'identity model must retain exact input length and alignment');
  assert.equal(observed.snapshot.modelFrames, observed.modelCalls);
  assert.ok(observed.snapshot.columns.length > 5, 'real samples should produce chart columns');
  for (const column of observed.snapshot.columns) assert.ok(column.change.every(value => value === 0), `misaligned input and output at ${column.index}`);
  assert.ok(observed.snapshot.columns.length <= LIVE_COLUMNS);
  console.log('PASS actual recording framer and delayed identity stream produce aligned, sample-identical observed output');

  const monitor = new LiveModelMonitor();
  const chunk = Float32Array.from({length: LIVE_PERIOD_SAMPLES}, (_, i) => Math.sin(i * .07));
  for (let i = 0; i < 6; i++) { monitor.observe(chunk, chunk, i !== 2); await tick(); }
  let snapshot = monitor.snapshot();
  assert.deepEqual(snapshot.columns.map(c => c.index), [1, 2, 4, 5, 6], 'a skipped analysis column stays blank');
  monitor.setEnabled(false);
  for (let i = 0; i < 4; i++) monitor.observe(chunk, chunk, true);
  assert.equal(monitor.snapshot().columns.length, 0);
  monitor.setEnabled(true); monitor.observe(chunk, chunk, true); await tick();
  snapshot = monitor.snapshot(); assert.deepEqual(snapshot.columns.map(c => c.index), [11]);
  for (let i = 0; i < 45; i++) { monitor.observe(chunk, chunk, true); await tick(); }
  snapshot = monitor.snapshot(); assert.ok(snapshot.columns.length <= LIVE_COLUMNS); assert.ok(snapshot.columns.every(c => c.index > snapshot.latestIndex - LIVE_COLUMNS));
  const beforeDispose = snapshot.modelFrames; monitor.dispose(); monitor.noteModelFrame(); monitor.observe(chunk, chunk, true); await tick();
  assert.equal(monitor.snapshot().modelFrames, beforeDispose); assert.equal(monitor.snapshot().columns.length, 0);
  console.log('PASS skipped, disabled and old display data never invent columns or grow without bound');

  const plugin = require(path.join(root, 'plugins/withDarkWindowBackground'));
  const styles = {resources:{style:[{$:{name:'AppTheme'},item:[{$:{name:'colorPrimary'},_:'#000000'}]},{$:{name:'Other'},item:[]}]}};
  plugin.applyDarkWindow(styles); plugin.applyDarkWindow(styles);
  const windowItems = styles.resources.style[0].item.filter(item => item.$.name === 'android:windowBackground');
  assert.equal(windowItems.length, 1); assert.equal(windowItems[0]._, '#0F172A');
  assert.throws(() => plugin.applyDarkWindow({resources:{style:[]}}), /AppTheme/);
  const layout = fs.readFileSync(path.join(root, 'src/app/_layout.tsx'), 'utf8');
  assert.match(layout, /contentStyle:\s*\{\s*backgroundColor:\s*COLORS\.background/);
  console.log('PASS Android activity and native-stack backgrounds are configured dark and plugin is idempotent');
  const modelHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, 'assets/model/denoiser_model.ort'))).digest('hex');
  assert.equal(modelHash, 'ec5ec24059035741763006dfaa6d463cfbbacf496caed5b5599ebe3477f2dd5b', 'live UI update must retain the exact bundled model');
  console.log('PASS bundled model hash matches the delivered 2.0.4 model');
})().catch(error => { console.error(error); process.exitCode = 1; });
