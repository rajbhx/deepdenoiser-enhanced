// Compile and run the actual direct-WAV parser against in-memory resolver stubs.
// Real Android content providers, codecs and filesystems still need device tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const native = path.join(root, 'modules/AudioProcessorModule/android/src/main/java/expo/modules/audioprocessormodule');
const source = fs.readFileSync(path.join(native, 'AudioProcessor.kt'), 'utf8');
function actual(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing Kotlin ${signature}`);
  const open = source.indexOf('{', start);let depth=0;
  for (let i=open;i<source.length;i++) {
    if(source[i]==='{')depth++;
    if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);
  }
  throw Error(`unbalanced Kotlin ${signature}`);
}
const functions = [
  'suspend fun extractWavAudio(', 'private fun processPcmFrames(', 'private fun readFully(',
  'private fun skipExact(', 'private fun readInt16LE(', 'private fun readInt32LE(',
].map(actual).join('\n');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'dd-wav-parser-'));
function run(command,args){
  const result=spawnSync(command,args,{stdio:'inherit',timeout:120000});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`${command} exited ${result.status}`);
}
try {
  const kt=`
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.BufferedInputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.EOFException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.coroutines.*
import expo.modules.audioprocessormodule.PcmIntegrity
object Dispatchers { val IO=Unit }
suspend fun <T> withContext(ignored: Unit, block: suspend () -> T): T = block()
fun <T> execute(block: suspend () -> T): T {
  var outcome: Result<T>? = null
  block.startCoroutine(object: Continuation<T> {
    override val context = EmptyCoroutineContext
    override fun resumeWith(result: Result<T>) { outcome=result }
  })
  return outcome!!.getOrThrow()
}
class Sink : ByteArrayOutputStream() {
  var writes=0
  override fun write(v:Int){writes++;super.write(v)}
  override fun write(v:ByteArray,off:Int,len:Int){writes++;super.write(v,off,len)}
}
class Resolver(val original:ByteArray) {
  var output:Sink?=null
  var allowOutput=true
  fun openInputStream(uri:String): InputStream? = if(uri=="input") ByteArrayInputStream(original) else null
  fun openOutputStream(uri:String): OutputStream? {
    if(uri!="output" || !allowOutput)return null
    return Sink().also { output=it }
  }
}
class Context(val contentResolver:Resolver)
class ActualParser(val context:Context) {
  fun getSafeUri(path:String)=path
  ${functions}
}
fun le16(value:Int)=byteArrayOf(value.toByte(),(value shr 8).toByte())
fun le32(value:Int)=byteArrayOf(value.toByte(),(value shr 8).toByte(),(value shr 16).toByte(),(value shr 24).toByte())
fun tag(value:String)=value.toByteArray(Charsets.US_ASCII)
fun shorts(vararg values:Int):ByteArray {
  val buffer=ByteBuffer.allocate(values.size*2).order(ByteOrder.LITTLE_ENDIAN)
  values.forEach { buffer.putShort(it.toShort()) };return buffer.array()
}
fun wav(data:ByteArray,channels:Int=1,bits:Int=16,rate:Int=48000,format:Int=1,junk:Boolean=false):ByteArray {
  val body=ByteArrayOutputStream();body.write(tag("WAVE"));body.write(tag("fmt "));body.write(le32(16));
  body.write(le16(format));body.write(le16(channels));body.write(le32(rate));body.write(le32(rate*channels*(bits/8)));
  body.write(le16(channels*(bits/8)));body.write(le16(bits));
  if(junk){body.write(tag("JUNK"));body.write(le32(3));body.write(byteArrayOf(1,2,3,0))}
  body.write(tag("data"));body.write(le32(data.size));body.write(data);if(data.size%2==1)body.write(0)
  val out=ByteArrayOutputStream();out.write(tag("RIFF"));out.write(le32(body.size()));out.write(body.toByteArray());return out.toByteArray()
}
fun decode(wave:ByteArray):Pair<Map<String,Any>,Resolver> {
  val resolver=Resolver(wave);val parser=ActualParser(Context(resolver))
  val result=execute { parser.extractWavAudio("input","output") }
  return result to resolver
}
fun failure(block:()->Unit):Throwable {try{block()}catch(e:Throwable){return e};error("expected failure")}
fun main(){
  val all=ByteBuffer.allocate(65536*2).order(ByteOrder.LITTLE_ENDIAN)
  for(v in -32768..32767)all.putShort(v.toShort())
  val wave=wav(all.array(),rate=44100,junk=true);val original=wave.copyOf()
  val (result,resolver)=decode(wave)
  check(result["path"]=="output" && result["sampleRate"]==44100)
  check(resolver.output!!.toByteArray().contentEquals(all.array()))
  check(resolver.output!!.writes==16) { "one write per 8192-byte PCM chunk expected" }
  check(wave.contentEquals(original))
  val stereo=shorts(-32768,-32768,-32768,32767,-10000,-20000,-10000,30000,32767,32767)
  check(decode(wav(stereo,channels=2)).second.output!!.toByteArray().contentEquals(shorts(-32768,0,-15000,10000,32767)))
  val unsigned8=byteArrayOf(0,128.toByte(),255.toByte())
  check(decode(wav(unsigned8,bits=8,junk=true)).second.output!!.toByteArray().contentEquals(shorts(-32768,0,32512)))
  val truncated=wav(shorts(-32768,32767)).copyOf(47)
  check(failure { decode(truncated) } is EOFException)
  val unsupported=wav(shorts(1,2),format=2)
  check(failure { decode(unsupported) }.message!!.contains("Unsupported WAV"))
  val inaccessible=Resolver(wave);inaccessible.allowOutput=false
  check(failure { execute { ActualParser(Context(inaccessible)).extractWavAudio("input","output") } }.message!!.contains("Failed to open PCM output"))
  println("PASS actual WAV parser handles chunked signed mono, stereo, padded chunks and 8-bit data; rejects truncation, unsupported format and inaccessible output")
}`;
  const file=path.join(scratch,'WavParser.kt'),jar=path.join(scratch,'wav-parser.jar');fs.writeFileSync(file,kt);
  run('javac',['-d',scratch,path.join(native,'PcmIntegrity.java')]);
  run(process.env.KOTLINC||'kotlinc',[file,'-classpath',scratch,'-include-runtime','-d',jar]);
  run('java',['-cp',`${jar}${path.delimiter}${scratch}`,'WavParserKt']);
} finally {fs.rmSync(scratch,{recursive:true,force:true})}
