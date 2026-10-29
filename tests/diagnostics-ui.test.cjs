/* Mocked React screen interaction tests; not a substitute for Android device testing. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const React=require('react'),renderer=require('react-test-renderer'),{act}=renderer;
const root=path.join(__dirname,'..');globalThis.IS_REACT_ACT_ENVIRONMENT=true;
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(mod,filename)=>mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);
let listeners=new Set(),snapshot={events:[],persistent:false,ready:true,storageError:null};
const S={alerts:[],routes:[],copied:[],shared:[],idle:true,sharePending:false,busy:false,reportInputs:[],prevent:null};
let resolveRun;const runPromise=new Promise(resolve=>{resolveRun=resolve});
const emit=()=>{for(const fn of listeners)fn()};
const theme={COLORS:{primary:'#00e',text:'#fff',subtext:'#aaa',background:'#000',surface:'#111',border:'#222',error:'#f00'}};
const device={versionName:'2.0.2',versionCode:4,debuggable:false,certificateSha256:'a'.repeat(64),androidDebugSubject:true,manufacturer:'Test',model:'Phone',androidVersion:'14',sdk:34,abi:'arm64-v8a',cpuCount:8,availableMemoryBytes:2**30,totalMemoryBytes:4*2**30,processPssBytes:2**28,freeStorageBytes:10*2**30,batteryPercent:42,microphoneGranted:true,notificationsEnabled:true,mediaAudioGranted:false,mediaVideoGranted:false,previousExit:null};
const mocks={
  'react-native':{View:'View',Text:'Text',TouchableOpacity:'TouchableOpacity',ScrollView:'ScrollView',Modal:'Modal',StyleSheet:{create:x=>x},Alert:{alert:(...args)=>S.alerts.push(args)},Linking:{openSettings:async()=>{},openURL:async url=>S.routes.push(url)},Share:{share:async info=>S.shared.push(info.message)}},
  'react-native-safe-area-context':{SafeAreaView:'SafeAreaView'},'@expo/vector-icons/Feather':'Feather',
  '@/src/constants/theme':theme,
  '@/modules/AudioProcessorModule':{getDiagnosticsInfo:async()=>device},
  '@siteed/audio-studio':{AudioStudioModule:{status:()=>({isWriterActive:!S.idle,isRecording:!S.idle,isPaused:false})}},
  'expo':{requireNativeModule:()=>({getShareIntentGeneration:()=>S.sharePending?'1':''})},
  'expo-clipboard':{setStringAsync:async value=>S.copied.push(value)},
  'expo-constants':{__esModule:true,default:{expoConfig:{extra:{diagnosticBuildCommit:'abcdef012345'}}}},
  'expo-router':{useRouter:()=>({back:()=>S.routes.push('back')})},
  'expo-router/react-navigation':{usePreventRemove:(active,callback)=>{S.prevent={active,callback}}},
  '@/src/scripts/denoiserSingleton':{getEngineLabel:()=> 'cpu x4'},
  '@/src/scripts/useProcessingBusy':{useProcessingBusy:()=>S.busy},
  '@/src/scripts/diagnostics':{
    initializeDiagnostics:async()=>{},getDiagnosticSnapshot:()=>snapshot,subscribeDiagnostics:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
    setDiagnosticPersistence:async enabled=>{snapshot={...snapshot,persistent:enabled};emit()},
    clearDiagnosticHistory:async()=>{snapshot={...snapshot,events:[]};emit()},
  },
  '@/src/scripts/diagnosticsCore':{EVENT_LABELS:{}},
  '@/src/scripts/diagnosticReport':{buildDiagnosticReport:input=>{S.reportInputs.push(input);return `PREVIEW device=${input.includeDevice}`}},
  '@/src/scripts/diagnosticSelfCheck':{runDiagnosticSelfCheck:()=>runPromise,benchmarkDiagnosticProvider:async()=>({checks:[],attemptedEngine:null,realtimeFactor:null})},
  '@/src/scripts/settings':{getSettings:async()=>({runtime:'auto'}),resolveCoreLevel:()=>4},
};
const originalLoad=Module._load;Module._load=function(request,parent,isMain){return Object.hasOwn(mocks,request)?mocks[request]:originalLoad.call(this,request,parent,isMain)};
const oldError=console.error;console.error=(...args)=>{if(!String(args[0]).includes('react-test-renderer is deprecated'))oldError(...args)};
const texts=node=>node.findAll(n=>n.type==='Text').map(n=>n.children.filter(c=>typeof c==='string').join('')).join(' ');
const button=(tree,text)=>{const matches=tree.root.findAll(n=>n.type==='TouchableOpacity'&&texts(n).includes(text));assert.ok(matches.length,`Missing ${text}`);return matches.at(-1)};
const click=async node=>act(async()=>node.props.onPress?.());
(async()=>{
  const Screen=require(path.join(root,'src/app/diagnostics/index.tsx')).default;let tree;
  await act(async()=>{tree=renderer.create(React.createElement(Screen))});
  assert.ok(texts(tree.root).includes('Private by default'));
  assert.equal(button(tree,'Run self-check').props.disabled,false);
  assert.equal(S.shared.length,0);assert.equal(S.copied.length,0);
  await click(button(tree,'Enable saved history'));let alert=S.alerts.at(-1);assert.equal(alert[0],'Save diagnostic history?');
  assert.equal(snapshot.persistent,false,'persistence must require confirmation');
  await act(async()=>alert[2].find(x=>x.text==='Enable').onPress());assert.equal(snapshot.persistent,true);
  await click(button(tree,'Turn off saved history'));alert=S.alerts.at(-1);
  await act(async()=>alert[2].find(x=>x.text==='Turn off & delete').onPress());assert.equal(snapshot.persistent,false);
  await click(button(tree,'Preview report'));assert.equal(tree.root.findByType('Modal').props.visible,true);
  assert.ok(texts(tree.root).includes('PREVIEW device=false'));assert.equal(S.copied.length,0);assert.equal(S.shared.length,0);
  await click(button(tree,'Copy report'));assert.deepEqual(S.copied,['PREVIEW device=false']);
  await click(button(tree,'Close'));const checkbox=tree.root.find(n=>n.props.accessibilityRole==='checkbox');
  await click(checkbox);await click(button(tree,'Preview report'));assert.ok(texts(tree.root).includes('PREVIEW device=true'));
  await click(button(tree,'Share report'));assert.deepEqual(S.shared,['PREVIEW device=true']);await click(button(tree,'Close'));
  await click(button(tree,'Run self-check'));assert.equal(button(tree,'Testing…').props.disabled,true);assert.equal(S.prevent.active,true);
  await act(async()=>resolveRun({checks:[{id:'private-file',label:'Private file',status:'passed',detail:'Synthetic only'}],attemptedEngine:'cpu x4',realtimeFactor:1}));
  assert.equal(S.prevent.active,false);assert.ok(texts(tree.root).includes('Synthetic only'));
  S.idle=false;await click(button(tree,'Refresh status'));assert.equal(button(tree,'Run self-check').props.disabled,true);
  await act(async()=>tree.unmount());
  console.log('PASS mocked diagnostics screen requires opt-in, previews reports and blocks active-recorder self-checks');
})().catch(e=>{console.error(e);process.exitCode=1});
