const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
// Resolve exactly as query-string does, not an unrelated top-level version.
const queryRequire = Module.createRequire(require.resolve('query-string'));
const decode = queryRequire('decode-uri-component');
const query = require('query-string');
assert.equal(decode('a+b%20c'), 'a b c', '0.2.x plus and space behavior remains');
assert.equal(decode('caf%C3%A9'), 'café');
assert.equal(decode('%FE%FF'), '\uFFFD\uFFFD');
assert.equal(decode('%C2'), '\uFFFD');
assert.equal(decode('%C3%A9%ZZ'), 'é%ZZ');
assert.throws(() => decode(null), TypeError);
assert.deepEqual({...query.parse('name=hello+world&symbol=%E2%82%B9')}, {name:'hello world', symbol:'₹'});
// Run a known pathological malformed percent sequence with a generous process
// timeout. The prior recursive 0.2.2 implementation can stall exponentially.
const child = spawnSync(process.execPath, ['-e', `
  const d = require(${JSON.stringify(queryRequire.resolve('decode-uri-component'))});
  const value = d('%C2'.repeat(10000) + '%ZZ');
  if (value.length !== 10003) process.exit(2);
`], {timeout: 5000, encoding: 'utf8'});
assert.equal(child.error, undefined, `malformed percent decode timed out: ${child.error}`);
assert.equal(child.status, 0, child.stderr);
console.log('PASS compatible CommonJS URI decoder handles malformed percent input without recursive blowup');
const filename = path.join(__dirname, '../src/app/+native-intent.ts');
const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = new Module(filename, module); mod.filename = filename; mod._compile(js, filename);
const {redirectSystemPath, MAX_EXTERNAL_PATH_LENGTH} = mod.exports;
const redirect = path => redirectSystemPath({path, initial: true});
assert.equal(redirect('deepdenoiser://home?x=1'), 'deepdenoiser://home?x=1');
assert.equal(redirect('x'.repeat(MAX_EXTERNAL_PATH_LENGTH)), 'x'.repeat(MAX_EXTERNAL_PATH_LENGTH));
assert.equal(redirect('x'.repeat(MAX_EXTERNAL_PATH_LENGTH + 1)), '/(tabs)');
assert.equal(redirect(null), '/(tabs)');
assert.equal(redirect('expo-sharing://share?x=' + 'A'.repeat(50000)), '/share-handler');
console.log('PASS external routes are bounded while native queued sharing is preserved');
