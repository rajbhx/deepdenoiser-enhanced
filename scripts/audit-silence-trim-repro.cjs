// Historical reproducer for the pre-fix 2.0.5 source, not a regression test.
// It is expected to fail against the fixed source; run tests/trim-dispatch.test.cjs instead.
// Extracts the original Kotlin trim/copy methods and dispatch branch and compiles
// them with the original PcmIntegrity.java,
// and executes synthetic PCM on the host JVM. No Android codec is exercised.
// Requires Java, javac and kotlinc on PATH, or set KOTLINC to its binary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourceDir = path.join(__dirname, '../modules/AudioProcessorModule/android/src/main/java/expo/modules/audioprocessormodule');
const source = fs.readFileSync(path.join(sourceDir, 'AudioProcessor.kt'), 'utf8');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trim-audit-'));

function blockEnd(open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return i;
  }
  throw new Error('Unbalanced Kotlin block');
}
function method(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `Missing Kotlin method ${signature}`);
  const open = source.indexOf('{', start);
  return source.slice(start, blockEnd(open) + 1);
}
function copyBranch() {
  const token = 'if (trimSegments != null && trimSegments.size > 1) {';
  const start = source.indexOf(token);
  assert.ok(start >= 0, 'Current multi-segment branch was not found; recheck this observation');
  const firstEnd = blockEnd(source.indexOf('{', start));
  const tail = source.slice(firstEnd + 1).match(/^\s*else\s*\{/);
  assert.ok(tail, 'Expected single-segment branch was not found');
  const secondOpen = firstEnd + 1 + tail[0].lastIndexOf('{');
  return source.slice(start, blockEnd(secondOpen) + 1);
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

try {
  const harness = `
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import kotlin.math.min
import kotlin.math.max
import expo.modules.audioprocessormodule.PcmIntegrity

class ExtractedTrim {
${method('private fun trimSegmentsFromFrames(')}
${method('private fun copyTrimmedSegments(')}
${method('private fun writeInt16Sample(')}

  fun segments(frames: FloatArray): List<Pair<Long, Long>> {
    val frameSamples = 480
    val frameSegments = trimSegmentsFromFrames(frames, frames.size, frameSamples, -40.0, 24000, true)
    return frameSegments.map { it.first * frameSamples to min(it.second * frameSamples + frameSamples - 1, frames.size.toLong() * frameSamples - 1) }
  }

  fun copyThroughOriginalBranch(data: ByteArray, selected: List<Pair<Long, Long>>): ByteArray {
    val trimSegments: List<Pair<Long, Long>>? = selected
    val trimStartSample = selected.first().first
    val trimEndSample = selected.last().second
    val trimmedDataLength = selected.sumOf { (it.second - it.first + 1) * 2 }
    val sampleRate = 48000
    val trimmed = trimStartSample > 0 || trimEndSample < data.size / 2 - 1 || selected.size > 1
    val inputStream = ByteArrayInputStream(data)
    val outputStream = ByteArrayOutputStream()
    ${copyBranch()}
    return outputStream.toByteArray()
  }
}

fun sample(bytes: ByteArray, i: Int): Int =
  (((bytes[i * 2].toInt() and 255) or ((bytes[i * 2 + 1].toInt() and 255) shl 8)).toShort()).toInt()
fun input(frames: FloatArray): ByteArray {
  val result = ByteArray(frames.size * 480 * 2)
  for (i in 0 until frames.size * 480) {
    val value = if (frames[i / 480] > -40) 20000 else 0
    result[2*i] = value.toByte()
    result[2*i+1] = (value shr 8).toByte()
  }
  return result
}
fun main() {
  val trim = ExtractedTrim()
  val one = FloatArray(150) { i -> if (i in 60..89) -6f else -80f }
  val oneSegments = trim.segments(one)
  check(oneSegments.size == 1)
  val oneOut = trim.copyThroughOriginalBranch(input(one), oneSegments)
  val first = sample(oneOut, 0)
  val last = sample(oneOut, oneOut.size / 2 - 1)
  check(first == 20000 && last == 20000)
  println("OBSERVED single kept segment: first=$first, last=$last (raw cut; no fade).")

  val two = FloatArray(240) { i -> if (i in 60..89 || i in 150..179) -6f else -80f }
  val twoSegments = trim.segments(two)
  check(twoSegments.size == 2)
  val twoOut = trim.copyThroughOriginalBranch(input(two), twoSegments)
  val twoFirst = sample(twoOut, 0)
  val twoLast = sample(twoOut, twoOut.size / 2 - 1)
  check(twoFirst in 1 until 20000 && twoLast == 20000)
  println("OBSERVED two segments: first=$twoFirst (faded), last=$twoLast (no trailing fade).")
  println("These are synthetic JVM observations of extracted production source, not an Android listening test.")
}
`;
  const kt = path.join(scratch, 'TrimAudit.kt');
  const jar = path.join(scratch, 'trim-audit.jar');
  fs.writeFileSync(kt, harness);
  run('javac', ['-d', scratch, path.join(sourceDir, 'PcmIntegrity.java')]);
  run(process.env.KOTLINC || 'kotlinc', [kt, '-classpath', scratch, '-include-runtime', '-d', jar]);
  run('java', ['-cp', `${jar}${path.delimiter}${scratch}`, 'TrimAuditKt']);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
