// Compile the actual Kotlin WAV frame conversion on a host JVM.
// The full RIFF parser, Android providers/codecs and physical device I/O are not tested here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../modules/AudioProcessorModule/android/src/main/java/expo/modules/audioprocessormodule/AudioProcessor.kt'), 'utf8');
function kotlinFunction(name) {
  const start = source.indexOf(`private fun ${name}(`);
  assert.ok(start >= 0, `missing Kotlin function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(`unbalanced function ${name}`);
}
const functions = ['processPcmFrames', 'readInt16LE', 'readInt32LE'].map(kotlinFunction).join('\n');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-wav-fallback-'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} exited ${result.status}`);
}
try {
  const kt = `
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

class CountingOutput : ByteArrayOutputStream() {
  var calls = 0
  override fun write(b: Int) { calls++; super.write(b) }
  override fun write(b: ByteArray, off: Int, len: Int) { calls++; super.write(b, off, len) }
}
class ActualWavFrames {
  ${functions}
  fun convert(data: ByteArray, channels: Int, bits: Int, format: Int = 1): Pair<ByteArray,Int> {
    val frameSize = channels * (bits / 8)
    check(data.size % frameSize == 0)
    val output = CountingOutput()
    processPcmFrames(data, data.size / frameSize, frameSize, channels, bits / 8, bits, format, output, "synthetic")
    return output.toByteArray() to output.calls
  }
}
fun shorts(vararg values: Int): ByteArray {
  val out = ByteBuffer.allocate(values.size * 2).order(ByteOrder.LITTLE_ENDIAN)
  values.forEach { out.putShort(it.toShort()) }; return out.array()
}
fun ints(vararg values: Int): ByteArray {
  val out = ByteBuffer.allocate(values.size * 4).order(ByteOrder.LITTLE_ENDIAN)
  values.forEach { out.putInt(it) }; return out.array()
}
fun floats(vararg values: Float): ByteArray {
  val out = ByteBuffer.allocate(values.size * 4).order(ByteOrder.LITTLE_ENDIAN)
  values.forEach { out.putFloat(it) }; return out.array()
}
fun pcm24(vararg values: Int): ByteArray {
  val out = ByteArray(values.size * 3)
  values.forEachIndexed { i, v -> out[3*i] = v.toByte(); out[3*i+1] = (v shr 8).toByte(); out[3*i+2] = (v shr 16).toByte() }
  return out
}
fun main() {
  val decoder = ActualWavFrames()
  val input = shorts(-32768, -20000, -1, 0, 1, 20000, 32767)
  val mono = decoder.convert(input, 1, 16)
  check(mono.first.contentEquals(input)) { "16-bit negative samples changed; input=" + input.contentToString() + " output=" + mono.first.contentToString() }
  val all = ByteBuffer.allocate(65536 * 2).order(ByteOrder.LITTLE_ENDIAN)
  for (v in -32768..32767) all.putShort(v.toShort())
  check(decoder.convert(all.array(), 1, 16).first.contentEquals(all.array())) { "16-bit mono must be byte-exact for every possible sample" }
  val stereo = shorts(-32768,-32768, -32768,32767, -10000,-20000, -10000,30000, 32767,32767)
  check(decoder.convert(stereo, 2, 16).first.contentEquals(shorts(-32768,0,-15000,10000,32767))) { "signed stereo averaging failed" }
  check(decoder.convert(byteArrayOf(0, 128.toByte(), 255.toByte()), 1, 8).first.contentEquals(shorts(-32768,0,32512)))
  check(decoder.convert(pcm24(-8388608,-256,0,8388352),1,24).first.contentEquals(shorts(-32768,-1,0,32767)))
  check(decoder.convert(ints(Int.MIN_VALUE,-65536,0,Int.MAX_VALUE),1,32).first.contentEquals(shorts(-32768,-1,0,32767)))
  check(decoder.convert(floats(-1f,-0.5f,0f,0.5f,1f),1,32,3).first.contentEquals(shorts(-32767,-16383,0,16383,32767)))
  check(mono.second <= 1) { "conversion should write one bounded PCM block, not one byte at a time: calls=" + mono.second }
  println("PASS actual WAV fallback preserves every signed 16-bit mono value, downmixes stereo, retains other formats and writes a bounded block")
}`;
  const file = path.join(scratch, 'WavFrames.kt'), jar = path.join(scratch, 'wav-frames.jar');
  fs.writeFileSync(file, kt);
  run(process.env.KOTLINC || 'kotlinc', [file, '-include-runtime', '-d', jar]);
  run('java', ['-jar', jar]);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
