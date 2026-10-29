// Diagnostic reproducer, not a desired-behavior regression test.
// Runs the actual TypeScript header repair against a disposable truncated WAV.
// It demonstrates that a declared-size mismatch is repaired without warning;
// it does not model Android process crashes or prove how truncation occurred.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-header-audit-'));
class File {
  constructor(uri) { this.uri = uri; }
  get exists() { return fs.existsSync(this.uri); }
  get size() { return fs.statSync(this.uri).size; }
  open() {
    const fd = fs.openSync(this.uri, 'r+');
    return {
      offset: 0,
      readBytes(length) {
        const bytes = Buffer.alloc(length);
        const read = fs.readSync(fd, bytes, 0, length, this.offset);
        this.offset += read;
        return new Uint8Array(bytes.buffer, bytes.byteOffset, read);
      },
      writeBytes(bytes) {
        fs.writeSync(fd, bytes, 0, bytes.length, this.offset);
        this.offset += bytes.length;
      },
      close() { fs.closeSync(fd); },
    };
  }
}

try {
  const filename = path.join(__dirname, '../src/scripts/recordingSafety.ts');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(__dirname);
  const stubs = {
    'expo-file-system': { File },
    '@siteed/audio-studio': { AudioStudioModule: {} },
  };
  mod.require = function (name) {
    return Object.hasOwn(stubs, name) ? stubs[name] : Module.prototype.require.call(this, name);
  };
  mod._compile(js, filename);

  const originalDataBytes = 19200; // 0.2 s of mono PCM16 at 48 kHz
  const lostBytes = 2000; // simulated truncation; an even number of bytes
  const wav = Buffer.alloc(44 + originalDataBytes, 0x12);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(originalDataBytes, 40);
  const truncated = wav.subarray(0, wav.length - lostBytes);
  const filePath = path.join(root, 'disposable-truncated-recording.wav');
  fs.writeFileSync(filePath, truncated);
  const before = fs.readFileSync(filePath);
  assert.equal(before.readUInt32LE(40), originalDataBytes);
  assert.equal(before.length - 44, originalDataBytes - lostBytes);

  const returnedBytes = mod.exports.ensureRecordingWavHeader(new File(filePath));
  const after = fs.readFileSync(filePath);
  assert.equal(returnedBytes, originalDataBytes - lostBytes);
  assert.equal(after.readUInt32LE(40), originalDataBytes - lostBytes);
  assert.equal(after.readUInt32LE(4), after.length - 8);
  assert.deepEqual(after.subarray(44), before.subarray(44));
  console.log(`OBSERVED: previously declared ${originalDataBytes} PCM bytes, only ${originalDataBytes - lostBytes} remained.`);
  console.log('The actual repair returned successfully and rewrote both sizes to the shorter length, without a truncation warning.');
  console.log('Remaining PCM bytes were unchanged. This does not prove that an Android recording has been truncated.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
