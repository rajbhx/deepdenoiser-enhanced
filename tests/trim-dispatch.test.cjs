// Extract the actual Kotlin WAV copy branch and run it with production Java PCM
// helpers on a host JVM. This does not exercise Android codecs or a device.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..'),src=path.join(root,'modules/AudioProcessorModule/android/src/main/java/expo/modules/audioprocessormodule');
const source=fs.readFileSync(path.join(src,'AudioProcessor.kt'),'utf8');
function end(open){let depth=0;for(let i=open;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&--depth===0)return i}throw Error('Unbalanced Kotlin block')}
const start=source.indexOf('if (trimmed && trimSegments != null) {');assert.ok(start>=0);
const firstEnd=end(source.indexOf('{',start));const tail=source.slice(firstEnd+1).match(/^\s*else\s*\{/);assert.ok(tail);
const secondOpen=firstEnd+1+tail[0].lastIndexOf('{');const branch=source.slice(start,end(secondOpen)+1);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'dd-trim-dispatch-'));
function run(command,args){const p=spawnSync(command,args,{stdio:'inherit',timeout:120000});if(p.error)throw p.error;if(p.status!==0)throw Error(`${command} exited ${p.status}`)}
try {
  const kt=`
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import expo.modules.audioprocessormodule.PcmIntegrity
fun copy(data: ByteArray, selected: List<Pair<Long,Long>>, trimmed: Boolean): ByteArray {
    val trimSegments: List<Pair<Long,Long>>? = selected
    val trimStartSample = selected.first().first
    val trimEndSample = selected.last().second
    val trimmedDataLength = selected.sumOf { (it.second-it.first+1)*2 }
    val pcmDataLength = data.size.toLong()
    val sampleRate = 48000
    val inputStream = ByteArrayInputStream(data)
    val outputStream = ByteArrayOutputStream()
    ${branch}
    return outputStream.toByteArray()
}
fun sample(b:ByteArray, i:Int) = ((b[2*i].toInt() and 255) or ((b[2*i+1].toInt() and 255) shl 8)).toShort().toInt()
fun main() {
    val input = ByteArray(2400*2)
    for(i in 0 until 2400){input[2*i]=20000.toByte();input[2*i+1]=(20000 shr 8).toByte()}
    val untrimmed=copy(input,listOf(0L to 2399L),false);check(untrimmed.contentEquals(input))
    val single=copy(input,listOf(200L to 1199L),true)
    check(single.size==2000 && sample(single,0)==0 && sample(single,999)==0 && sample(single,500)==20000)
    val multi=copy(input,listOf(200L to 799L,1400L to 1999L),true)
    check(multi.size==2400 && sample(multi,0)==0 && sample(multi,599)==0 && sample(multi,600)==0 && sample(multi,1199)==0)
    val short=copy(input,listOf(100L to 102L),true);check(short.size==6 && sample(short,0)==0 && sample(short,2)==0)
    println("PASS actual Kotlin WAV dispatch fades single/multiple cuts with the complete source length")
}`;
  fs.writeFileSync(path.join(scratch,'TrimDispatch.kt'),kt);
  run('javac',['-d',scratch,path.join(src,'PcmIntegrity.java')]);
  const jar=path.join(scratch,'trim.jar');
  run(process.env.KOTLINC||'kotlinc',[path.join(scratch,'TrimDispatch.kt'),'-classpath',scratch,'-include-runtime','-d',jar]);
  run('java',['-cp',`${jar}${path.delimiter}${scratch}`,'TrimDispatchKt']);
} finally {fs.rmSync(scratch,{recursive:true,force:true})}
