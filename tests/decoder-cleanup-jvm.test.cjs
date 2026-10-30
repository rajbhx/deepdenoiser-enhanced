// Execute the real Kotlin decoder catch/finally blocks with failure-injecting stubs.
// This does not simulate Android's media service, codecs, or provider behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../modules/AudioProcessorModule/android/src/main/java/expo/modules/audioprocessormodule/AudioProcessor.kt'), 'utf8');
const begin = source.indexOf('suspend fun decodeToPCM(');
const end = source.indexOf('// (4) PCM to WAV Conversion', begin);
assert.ok(begin >= 0 && end > begin);
const decode = source.slice(begin, end);
const finallyStart = decode.lastIndexOf('} finally {');
const catchStart = decode.lastIndexOf('} catch (failure: Throwable) {', finallyStart);
assert.ok(catchStart >= 0 && finallyStart > catchStart, 'decoder must preserve primary failure before cleanup');
const open = decode.indexOf('{', finallyStart);
let depth = 0, close = -1;
for (let i = open; i < decode.length; i++) {
  if (decode[i] === '{') depth++;
  if (decode[i] === '}' && --depth === 0) { close = i; break; }
}
assert.ok(close > open);
const tail = decode.slice(catchStart, close + 1);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-decode-cleanup-'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} exited ${result.status}`);
}
try {
  const kt = `
import java.io.IOException
class FakeCodec(val stopFailure: Throwable? = null, val releaseFailure: Throwable? = null) {
  var stopped = 0; var released = 0
  fun stop() { stopped++; stopFailure?.let { throw it } }
  fun release() { released++; releaseFailure?.let { throw it } }
}
class FakeExtractor(val failure: Throwable? = null) {
  var released = 0
  fun release() { released++; failure?.let { throw it } }
}
class FakeOutput(val failure: Throwable? = null) {
  var closed = 0
  fun close() { closed++; failure?.let { throw it } }
}
fun execute(primary: Throwable?, suppliedCodec: FakeCodec?, suppliedExtractor: FakeExtractor?, suppliedOutput: FakeOutput?, started: Boolean = true) {
  var codec: FakeCodec? = suppliedCodec
  var extractor: FakeExtractor? = suppliedExtractor
  var outputStream: FakeOutput? = suppliedOutput
  var isCodecStarted = started
  var primaryFailure: Throwable? = null
  try { if (primary != null) throw primary
  ${tail}
}
fun thrown(block: () -> Unit): Throwable {
  try { block() } catch (failure: Throwable) { return failure }
  error("expected a failure")
}
fun main() {
  val primary = IOException("decode failure")
  val codecError = IllegalStateException("codec release")
  val extractError = IllegalStateException("extractor release")
  val closeError = IOException("close failure")
  val codec = FakeCodec(releaseFailure = codecError); val extractor = FakeExtractor(extractError); val output = FakeOutput(closeError)
  check(thrown { execute(primary,codec,extractor,output) } === primary)
  check(codec.stopped == 1 && codec.released == 1 && extractor.released == 1 && output.closed == 1)
  check(primary.suppressed.contentEquals(arrayOf(codecError)))
  check(codecError.suppressed.contentEquals(arrayOf(extractError,closeError)))

  val a = IllegalStateException("release only"); val b = IOException("extractor")
  val c2 = FakeCodec(releaseFailure=a); val e2=FakeExtractor(b); val o2=FakeOutput()
  check(thrown { execute(null,c2,e2,o2) } === a)
  check(a.suppressed.contentEquals(arrayOf(b)) && c2.released==1 && e2.released==1 && o2.closed==1)

  val c3=FakeCodec(stopFailure=IllegalStateException("already stopped")); val e3=FakeExtractor(); val o3=FakeOutput()
  execute(null,c3,e3,o3); check(c3.stopped==1 && c3.released==1 && e3.released==1 && o3.closed==1)
  val fatal=AssertionError("fatal stop"); val c4=FakeCodec(stopFailure=fatal); val e4=FakeExtractor(); val o4=FakeOutput()
  check(thrown { execute(null,c4,e4,o4) } === fatal)
  check(c4.released==1 && e4.released==1 && o4.closed==1)

  val same=IOException("same object"); val c5=FakeCodec(releaseFailure=same); val e5=FakeExtractor(same); val o5=FakeOutput(same)
  check(thrown { execute(same,c5,e5,o5) } === same)
  check(same.suppressed.isEmpty() && c5.released==1 && e5.released==1 && o5.closed==1)
  val original=IOException("original reused"); val other=IOException("other cleanup")
  val c6=FakeCodec(releaseFailure=other); val e6=FakeExtractor(original); val o6=FakeOutput()
  check(thrown { execute(original,c6,e6,o6) } === original)
  check(original.suppressed.contentEquals(arrayOf(other)) && other.suppressed.isEmpty() && o6.closed==1)
  val e7=FakeExtractor(); val o7=FakeOutput(); execute(null,null,e7,o7,false); check(e7.released==1 && o7.closed==1)
  println("PASS actual decoder cleanup releases all resources, preserves the primary failure, and reports cleanup-only failures")
}`;
  const file = path.join(scratch, 'DecodeCleanup.kt'), jar = path.join(scratch, 'decoder-cleanup.jar');
  fs.writeFileSync(file, kt);
  run(process.env.KOTLINC || 'kotlinc', [file, '-include-runtime', '-d', jar]);
  run('java', ['-jar', jar]);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
