// Execute the actual patched Kotlin catch and flush code with host stubs.
// AudioRecord, Android lifecycle, service notification, and physical I/O failure
// are NOT simulated here and must still be tested on an Android device.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const file=path.join(__dirname,'../node_modules/@siteed/audio-studio/android/src/main/java/net/siteed/audiostudio/AudioRecorderManager.kt');
const source=fs.readFileSync(file,'utf8');const begin=source.indexOf('private fun recordingProcess()'),end=source.indexOf('private fun emitAudioData(',begin);
assert.ok(begin>=0&&end>begin);const worker=source.slice(begin,end),catchStart=worker.lastIndexOf('} catch (e: Exception) {');assert.ok(catchStart>=0);
const open=worker.indexOf('{',catchStart+2);let depth=0,close=-1;
for(let i=open;i<worker.length;i++){if(worker[i]==='{')depth++;if(worker[i]==='}'&&--depth===0){close=i;break}}assert.ok(close>open);
const catchBlock=worker.slice(catchStart,close+1);
const flushStart=worker.indexOf('var flushFailure: Exception? = null');const flushEnd=worker.indexOf('flushFailure?.let { throw it }',flushStart);assert.ok(flushStart>=0&&flushEnd>flushStart);
const flushBlock=worker.slice(flushStart,flushEnd+'flushFailure?.let { throw it }'.length);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'dd-worker-safety-'));
function run(cmd,args){const p=spawnSync(cmd,args,{stdio:'inherit',timeout:120000});if(p.error)throw p.error;if(p.status!==0)throw Error(`${cmd} exited ${p.status}`)}
try {
  const kt=`
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
object LogUtils { fun e(name:String,msg:String,e:Exception) {} }
object Constants { const val RECORDING_INTERRUPTED_EVENT_NAME = "onRecordingInterrupted" }
object AudioRecordingService { var reports=0; fun reportRecordingFailure(){reports++} }
fun bundleOf(vararg pairs:Pair<String,Any?>) = mapOf(*pairs)
class Handler { val pending=mutableListOf<()->Unit>(); fun post(block:()->Unit){pending.add(block)}; fun run(){pending.toList().forEach{it()};pending.clear()} }
class Sender { val events=mutableListOf<Map<String,Any?>>(); fun sendExpoEvent(name:String,bundle:Map<String,Any?>){events.add(bundle)} }
class ExtractedFailure {
  private val CLASS_NAME="test"
  private val _isRecording=AtomicBoolean(true)
  private val isPaused=AtomicBoolean(false)
  private var streamUuid:String?="session-a"
  private var audioFile:File?=File("/tmp/original.wav")
  private val mainHandler=Handler()
  private val eventSender=Sender()
  @Volatile private var recordingThreadError:Exception?=null
  private var released=false
  private fun releaseWakeLock(){released=true}
  fun inject(message:String){ try { throw IOException(message) ${catchBlock} }
  fun testNormal() {
    inject("synthetic write failure")
    check(recordingThreadError?.message=="synthetic write failure")
    check(_isRecording.get());check(released);check(eventSender.events.isEmpty())
    mainHandler.run();check(eventSender.events.size==1)
    check(eventSender.events[0]["reason"]=="recordingFailed")
    check(eventSender.events[0]["streamUuid"]=="session-a")
    check(eventSender.events[0]["fileUri"].toString().endsWith("/original.wav"))
    check(AudioRecordingService.reports==1)
  }
  fun testStale() {
    inject("synthetic read failure");streamUuid="session-b";mainHandler.run();check(eventSender.events.isEmpty())
    check(AudioRecordingService.reports==1)
  }
  fun testStopRace() {
    inject("synthetic close failure");_isRecording.set(false);mainHandler.run();check(eventSender.events.isEmpty())
    check(AudioRecordingService.reports==1)
  }
}
class BadOutput(val failFlush:Boolean,val failClose:Boolean) {
  var closed=false
  fun flush(){if(failFlush)throw IOException("flush failed")}
  fun close(){closed=true;if(failClose)throw IOException("close failed")}
}
fun finish(fos:BadOutput?) { val CLASS_NAME="test"; ${flushBlock} }
fun main(){
  ExtractedFailure().testNormal();ExtractedFailure().testStale();ExtractedFailure().testStopRace()
  val bad=BadOutput(true,false);try{finish(bad);error("flush failure swallowed")}catch(e:IOException){check(e.message=="flush failed")};check(bad.closed)
  val both=BadOutput(true,true);try{finish(both);error("close failure swallowed")}catch(e:IOException){check(e.message=="close failed");check(e.suppressed.size==1)};check(both.closed)
  println("PASS extracted worker catch reports session-specific failure and handles stale/Stop races; flush failures close and propagate")
}`;
  const target=path.join(scratch,'WorkerSafety.kt'),jar=path.join(scratch,'worker.jar');fs.writeFileSync(target,kt);
  run(process.env.KOTLINC||'kotlinc',[target,'-include-runtime','-d',jar]);run('java',['-jar',jar]);
} finally {fs.rmSync(scratch,{recursive:true,force:true})}
