#!/usr/bin/env node
/*
 * Rebuild the locally resolved npm dependency inventory and include available
 * license/NOTICE files. This deliberately over-includes build-time packages
 * reachable from app dependencies and is NOT a Gradle/native/model SBOM.
 * Run on the same platform and with the same locked, patched install as CI.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'assets/generated/licenses.json');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function findPackage(name, from) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir || !dir.startsWith(root + path.sep)) return null;
    dir = parent;
  }
}
function repositoryOf(pkg) {
  let url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!url) return undefined;
  url = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
  return /^https:\/\//.test(url) ? url : undefined;
}
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (typeof pkg.license?.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(item => typeof item === 'string' ? item : item.type).filter(Boolean).join(' OR ') || 'UNKNOWN';
  return 'UNKNOWN';
}
function noticesIn(dir) {
  return fs.readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice)(\.[^.]+)?$/i.test(name)).sort().flatMap(name => {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    // Unexpected giant/binary files require manual review rather than bloating the app.
    if (!stat.isFile() || stat.size > 500_000) return [];
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('\u0000') ? [] : [{ file: name, text }];
  });
}
const records = {};
const visited = new Set();
const missing = new Set();
function visit(name, from, required = false) {
  const dir = findPackage(name, from);
  if (!dir) { if (required) missing.add(name); return; }
  if (visited.has(dir)) return;
  visited.add(dir);
  const pkg = readJson(path.join(dir, 'package.json'));
  const key = `${pkg.name || name}@${pkg.version || 'UNKNOWN'}`;
  const license = licenseOf(pkg);
  const repository = repositoryOf(pkg);
  let notices = noticesIn(dir);
  // Many published Expo workspace packages omit their repository-root license.
  // Label the fallback explicitly; release review must verify its applicability.
  if (!notices.length && license === 'MIT' && repository === 'https://github.com/expo/expo') {
    notices = [{ file: 'Expo repository LICENSE (shared fallback; review)', text: fs.readFileSync(path.join(root, 'node_modules/expo/LICENSE'), 'utf8') }];
  }
  if (!notices.length && /^onnxruntime-(react-native|common)$/.test(pkg.name || '') && pkg.version === '1.24.3') {
    notices = [{ file: 'ONNX Runtime v1.24.3 LICENSE (upstream)', text: fs.readFileSync(path.join(root, 'docs/third-party/onnxruntime/LICENSE'), 'utf8') }];
  }
  if (pkg.name === 'onnxruntime-react-native' && pkg.version === '1.24.3') {
    notices.push({ file: 'ONNX Runtime v1.24.3 ThirdPartyNotices.txt (upstream; review against shipped binary)', text: fs.readFileSync(path.join(root, 'docs/third-party/onnxruntime/ThirdPartyNotices.txt'), 'utf8') });
  }
  const record = { licenses: license, ...(repository ? { repository } : {}), notices };
  if (records[key] && JSON.stringify(records[key]) !== JSON.stringify(record)) {
    throw new Error(`Conflicting installed copies of ${key}; review manually`);
  }
  records[key] = record;
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).sort()) {
    // Optional and peer dependencies can be absent legitimately. Missing
    // package dependencies are surfaced in the output for follow-up review.
    visit(dep, dir, !!pkg.dependencies?.[dep] && !pkg.optionalDependencies?.[dep]);
  }
}
for (const name of Object.keys(packageJson.dependencies).sort()) visit(name, root, true);
if (missing.size) throw new Error(`Unresolved installed dependencies: ${[...missing].sort().join(', ')}`);
records[`DeepDenoiser app@${packageJson.version}`] = {
  licenses: 'GPL-3.0', repository: 'https://github.com/rajbhx/deepdenoiser-enhanced',
  notices: [{ file: 'Application LICENSE', text: fs.readFileSync(path.join(root, 'LICENSE'), 'utf8') }],
};
const model = fs.readFileSync(path.join(root, 'assets/model/denoiser_model.ort'));
records['Bundled model — provenance and license UNVERIFIED'] = {
  licenses: 'REVIEW REQUIRED',
  notices: [{ file: 'Model identity and release blocker', text: `File: assets/model/denoiser_model.ort\nSHA-256: ${crypto.createHash('sha256').update(model).digest('hex')}\nThe exact origin, version, model-weight license and conversion history have not been verified. Do not distribute until reviewed.\n` }],
};
const text = JSON.stringify(Object.fromEntries(Object.entries(records).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== text) {
    console.error('Third-party inventory is stale. Run node scripts/generate-notices.cjs on a clean locked install.');
    process.exit(1);
  }
  console.log(`PASS ${Object.keys(records).length} resolved npm/model/app notice records match the locked install`);
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, text);
  const missingText = Object.values(records).filter(record => !record.notices.length).length;
  console.log(`Wrote ${Object.keys(records).length} npm/model/app records; ${missingText} have no local notice text and need review.`);
}
