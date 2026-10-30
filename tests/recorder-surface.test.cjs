/* Source and configuration checks; these do not replace Android device tests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

assert.equal(fs.existsSync(path.join(root, 'src/components/LiveModelView.tsx')), false);
assert.equal(fs.existsSync(path.join(root, 'src/scripts/liveModelMonitor.ts')), false);
const recorder = source('src/app/recording/index.tsx');
assert.doesNotMatch(recorder, /LiveModelView|LiveModelMonitor|liveModelMonitor|monitorRef|setLiveSession/);
assert.match(recorder, /new BoundedRecordingQueue/);
assert.match(recorder, /denoiser\.processFrame\(state, frame, output\)/);
assert.match(recorder, /queue\.drain\(\)/);
assert.match(recorder, /reconcileRecording\(/);
assert.match(recorder, /Live queue is full/);
assert.match(recorder, /Live cleaning stopped/);
console.log('PASS recorder removes visualization while retaining model, bounded queue, reconciliation and warnings');

const plugin = require(path.join(root, 'plugins/withDarkWindowBackground'));
const styles = {resources:{style:[{$:{name:'AppTheme'},item:[{$:{name:'colorPrimary'},_:'#000000'}]},{$:{name:'Other'},item:[]}]}};
plugin.applyDarkWindow(styles); plugin.applyDarkWindow(styles);
const windowItems = styles.resources.style[0].item.filter(item => item.$.name === 'android:windowBackground');
assert.equal(windowItems.length, 1); assert.equal(windowItems[0]._, '#0F172A');
assert.throws(() => plugin.applyDarkWindow({resources:{style:[]}}), /AppTheme/);
assert.match(source('src/app/_layout.tsx'), /contentStyle:\s*\{\s*backgroundColor:\s*COLORS\.background/);
console.log('PASS Android activity and native-stack backgrounds are configured dark and plugin is idempotent');

const app = JSON.parse(source('app.json'));
const pkg = JSON.parse(source('package.json'));
assert.equal(app.expo.version, '2.0.6');
assert.equal(app.expo.android.versionCode, 8);
assert.equal(pkg.version, app.expo.version);
console.log('PASS test build has a distinct, consistent 2.0.6/version-code-8 identity');

const modelHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'assets/model/denoiser_model.ort'))).digest('hex');
assert.equal(modelHash, 'ec5ec24059035741763006dfaa6d463cfbbacf496caed5b5599ebe3477f2dd5b', 'the exact bundled model must remain unchanged');
const referenceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'tests/fixtures/liveModelMonitor-2.0.5-reference.txt'))).digest('hex');
assert.equal(referenceHash, '774cdfa703e435ec12b8a32e15240c885e33c67db43cae772fcac47188bbec61', 'the historical observer reference must not change');
console.log('PASS bundled model and test-only 2.0.5 comparison fixture match their recorded hashes');
