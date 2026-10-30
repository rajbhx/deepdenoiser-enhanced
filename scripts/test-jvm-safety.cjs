// Compile and exercise the actual platform-independent native source on the host JVM.
// Android codecs, services, UI and file-system behavior still require device tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root=path.join(__dirname,'..');
const source=path.join(root,'modules/AudioProcessorModule/android/src/main/java/expo/modules/audioprocessormodule');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'dd-jvm-safety-'));
function run(command,args){const p=spawnSync(command,args,{stdio:'inherit',timeout:120000});if(p.error)throw p.error;if(p.status!==0)throw Error(`${command} exited ${p.status}`)}
try {
  run('javac',['-d',scratch,...['PcmIntegrity.java','AtomicFileWriter.java','NoReplaceFile.java'].map(f=>path.join(source,f)),
    ...['PcmIntegrityTest.java','TrimSegmentsTest.java','AtomicFileWriterTest.java','NoReplaceFileTest.java'].map(f=>path.join(root,'tests',f))]);
  for(const name of ['PcmIntegrityTest','TrimSegmentsTest','AtomicFileWriterTest','NoReplaceFileTest'])run('java',['-cp',scratch,name]);
} finally {fs.rmSync(scratch,{recursive:true,force:true})}
