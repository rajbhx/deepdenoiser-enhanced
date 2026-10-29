/* React-level regressions with mocked native modules. These do not replace Android device tests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { act } = TestRenderer;
const root=path.join(__dirname,'..');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
require.extensions['.png']=(mod,filename)=>{mod.exports=filename};
for(const ext of ['.ts','.tsx']) require.extensions[ext]=(mod,filename)=>{
  const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  mod._compile(code,filename);
};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const S={};
const theme={COLORS:{primary:'#00E5FF',background:'#0F172A',surface:'#1E293B',text:'#F8FAFC',subtext:'#94A3B8',success:'#10B981',error:'#EF4444',border:'#334155',white:'#FFFFFF'},SPACING:{small:8,medium:16},FONT_SIZE:{body:16,small:14,heading:20},Styles:new Proxy({}, {get:()=>({})})};
const RN={View:'View',Text:'Text',Pressable:'Pressable',TouchableOpacity:'TouchableOpacity',ScrollView:'ScrollView',Modal:'Modal',
  StyleSheet:{create:x=>x,absoluteFill:{}},useWindowDimensions:()=>({width:320,height:480}),
  Alert:{alert:(...args)=>S.alerts.push(args)},
  Animated:{View:'Animated.View',Value:class{constructor(v){this.value=v}setValue(v){this.value=v}},timing:()=>({start(){},stop(){}}),sequence:()=>({start(){},stop(){}}),loop:()=>({start(){},stop(){}})},
};
const reanimated={__esModule:true,default:{View:'Animated.View'},useSharedValue:v=>React.useRef({value:v}).current,useAnimatedStyle:fn=>fn(),withSpring:v=>v,runOnJS:fn=>fn};
function gesture(kind){const obj={kind,callbacks:{}};for(const n of ['onBegin','onUpdate','onEnd','onFinalize'])obj[n]=fn=>(obj.callbacks[n]=fn,obj);for(const n of ['enabled','minDistance'])obj[n]=()=>obj;return obj}
const GH={Gesture:{Pan:()=>gesture('pan'),Tap:()=>gesture('tap'),Race:(...items)=>({items})},GestureDetector:'GestureDetector',GestureHandlerRootView:'GestureHandlerRootView'};
class FakeFile {
  constructor(...parts){const values=parts.map(p=>typeof p==='string'?p:p.uri);this.uri=values.length===1?values[0]:values.map((p,i)=>i===0?p.replace(/\/$/,''):p.replace(/^\//,'')).join('/');this.name=decodeURIComponent(this.uri.split('/').pop())}
  get exists(){return S.files.has(this.uri)} get size(){return S.files.get(this.uri)?.size||0} get modificationTime(){return 100}
  create(){S.files.set(this.uri,{size:0})} delete(){S.files.delete(this.uri)}
}
const FS={File:FakeFile,Directory:class{},Paths:{cache:{uri:'file:///cache'},document:{uri:'file:///doc'}}};
const router={back:()=>S.routes.push('back'),canGoBack:()=>true,push:value=>S.routes.push(value),replace:value=>S.routes.push(value),navigate:value=>S.routes.push(value)};
const defaultSettings=()=>({attenLimDb:0,attenPreset:'max',runtime:'auto',coreMode:'auto',coreLevel:4});
const settingsMock={ATTEN_PRESET_DB:{light:20,medium:10,strong:5,max:0},getSettings:()=>S.getSettings(),updateSettings:patch=>S.updateSettings(patch),resolveCoreLevel:()=>4,incrementDenoiseCount:async()=>{}};
const denoiser={createStream:value=>(S.streamStrength=value,{}),processFrame:async(_s,x)=>x};
const singleton={beginRun:()=>{S.began++},endRun:()=>{S.ended++},isProcessingMedia:()=>false,getEngineLabel:()=> 'not-loaded',resetDenoiser:async()=>{},getDenoiser:()=>S.getDenoiser()};
const nativeSafety={assertNativeRecorderIdle:()=>{S.statusChecks++;if(!S.nativeIdle)throw new Error('Native writer active')},
  BoundedRecordingQueue:class{constructor(){this.error=null;this.overloaded=false}async drain(){}},
  ensureRecordingWavHeader:()=>{if(S.invalidRecording)throw new Error('Recording has no WAV header');return 56},
  reconcileRecording:async()=>false,recordingsDir:()=>({uri:'file:///doc/recordings'})};
const cacheMock={cleanupTempCache:async()=>{},placeOutput:async f=>f,readImportedMediaKind:f=>S.kinds.get(f.uri)||null,
  setImportedMediaKind:async(f,kind)=>{S.kinds.set(f.uri,kind)},removeImportedMediaKind:()=>{},getRebuildableCacheBytes:async()=>0,clearRebuildableCache:async()=>{},
  importToDocuments:async(uri,name,_fallback,kind)=>{S.imports.push({uri,name,kind});const id=uri.split('/').pop();const f=new FakeFile(`file:///doc/imports/${id}`);S.files.set(f.uri,{size:100});if(kind&&!S.kinds.has(f.uri))S.kinds.set(f.uri,kind);return f}};
function getAudioPlayer(uri){
  if(!S.players[uri]) S.players[uri]={uri,currentTime:0,duration:100,playing:false,pause(){this.playing=false},play(){this.playing=true;S.plays++},seekTo:async time=>{S.seeks.push(time)},replace:()=>{S.retries++}};
  return S.players[uri];
}
function getVideoPlayer(uri){
  if(!S.videos[uri]){const listeners={};S.videos[uri]={uri,pauses:0,pause(){this.pauses++},replaceAsync:async()=>{},addListener(name,cb){listeners[name]=cb;return{remove(){delete listeners[name]}}},emit(name,event){listeners[name]?.(event)}}}
  return S.videos[uri];
}
const mocks={
  'react-native':RN,'react-native-reanimated':reanimated,'react-native-gesture-handler':GH,
  'react-native-safe-area-context':{SafeAreaView:'SafeAreaView',useSafeAreaInsets:()=>({top:0,bottom:0})},
  '@expo/vector-icons/Feather':'Feather','@expo/vector-icons':{Feather:'Feather'},
  '@expo/ui/jetpack-compose':{Host:'Host',LoadingIndicator:'LoadingIndicator',Switch:'Switch'},
  'expo-file-system':FS,'expo-image':{Image:'Image'},
  'expo-router':{useRouter:()=>router,useIsFocused:()=>S.focused,useLocalSearchParams:()=>S.params},
  'expo-router/react-navigation':{useFocusEffect:callback=>React.useEffect(callback,[callback]),usePreventRemove:(active,callback)=>{S.prevent={active,callback}}},
  'expo-audio':{requestRecordingPermissionsAsync:async()=>({granted:true}),useAudioPlayer:getAudioPlayer,useAudioPlayerStatus:player=>S.audioStatus[player.uri]},
  'expo-video':{useVideoPlayer:(uri,setup)=>{const p=getVideoPlayer(uri);setup?.(p);return p},VideoView:'VideoView'},
  'expo-constants':{__esModule:true,default:{expoConfig:{version:'2.0.1'}}},
  '@siteed/audio-studio':{useAudioRecorder:()=>{const [recording,setRecording]=React.useState(false);return{
    isRecording:recording,isPaused:false,durationMs:0,
    startRecording:async config=>{const result=await S.nativeStart(config);setRecording(true);return result},
    stopRecording:async()=>{const result=await S.nativeStop();setRecording(false);return result},pauseRecording:async()=>{},resumeRecording:async()=>{},
  }}},
  '@/src/constants/theme':theme,'@/assets/model/model_metadata.json':{hop_size:480,algorithmic_delay_samples:0},
  '@/src/components/advanceSettings':'AdvanceSettings','@/src/components/audioPlayer':'AudioPlayer','@/src/components/CompareAudioPlayer':'CompareAudioPlayer',
  '@/src/components/ErrorModal':'ErrorModal','@/src/components/SaveButton':'SaveButton','@/src/components/shareBtn':'ShareBtn','@/src/components/videoPlayer':'VideoPlayer',
  '@/src/components/customSlider':'CustomSlider','@/src/components/silenceTrimSettings':'SilenceTrimSettingsBlock','@/src/components/SettingsSidebar':'SettingsSidebar',
  '@/src/scripts/settings':settingsMock,'../scripts/settings':settingsMock,
  '@/src/scripts/denoiserSingleton':singleton,'../scripts/denoiserSingleton':singleton,
  '@/src/scripts/recordingSafety':nativeSafety,'@/src/scripts/denoiseCache':cacheMock,
  '@/src/scripts/alignedDenoiseStream':{AlignedDenoiseStream:class{async push(v){return v}async finish(){return new Float32Array()}}},
  '@/src/scripts/analytics':{trackAppEvent(){},trackAppError(){}},
  '@/src/scripts/diagnostics':{recordDiagnostic(){},recordDiagnosticError(){}},
  '@/src/scripts/silenceTrim':{DEFAULT_SILENCE_TRIM:{enabled:false,mode:'auto',thresholdDb:-40,minSilenceMs:500}},
  '@/src/scripts/formatHandler':{PCMtoWav:async()=>({file:new FakeFile('file:///cache/partial.wav')}),writePCMChunk:async()=>{},saveToDevice:()=>S.save(),savedMediaLocation:()=> 'Music/DeepDenoiser Audio'},
  '@/src/scripts/processMedia':{processMedia:(...args)=>S.processMedia(...args)},
  '@/src/scripts/privateMedia':{listPrivateMedia:()=>S.privateMedia.filter(item=>item.file.exists).map(item=>{const kind=S.kinds.get(item.file.uri);return item.group==='imports'&&kind?{...item,kindKnown:true,video:kind==='video'}:item})},
  '@/src/scripts/documentPicker':{pickDocument:()=>S.pickDocument()},
  '@/src/scripts/useRawIncomingShare':{useRawIncomingShare:()=>S.share,isCurrentShare:()=>true},
  '@/src/scripts/useProcessingBusy':{useProcessingBusy:()=>S.processingBusy},
  '@/src/scripts/shareClaim':{claimSharedBatch:()=> 'claim',finishSharedBatch(){}},
  '@/src/scripts/sharedImport':{importSharedMedia:(...args)=>S.importSharedMedia(...args)},
};
const oldLoad=Module._load;
Module._load=function(request,parent,isMain){if(Object.hasOwn(mocks,request))return mocks[request];if(request.startsWith('@/'))return oldLoad.call(this,path.join(root,request.slice(2)),parent,isMain);return oldLoad.call(this,request,parent,isMain)};
function reset(){
  Object.assign(S,{alerts:[],routes:[],files:new Map(),kinds:new Map(),imports:[],params:{},prevent:null,audioStatus:{},players:{},videos:{},plays:0,seeks:[],retries:0,began:0,ended:0,statusChecks:0,nativeIdle:true,invalidRecording:false,privateMedia:[],streamStrength:null,focused:true,processingBusy:false});
  S.getSettings=async()=>defaultSettings();S.updateSettings=async patch=>({...defaultSettings(),...patch});S.getDenoiser=async()=>denoiser;
  S.nativeStart=async()=>({fileUri:'file:///doc/recordings/test.wav'});S.nativeStop=async()=>({fileUri:'file:///doc/recordings/test.wav'});
  S.processMedia=async()=>({file:new FakeFile('file:///doc/denoised/out.wav'),seconds:1,cached:false,trimEnabled:false});S.pickDocument=async()=>({canceled:true});S.save=async()=> 'content://saved';
  S.discards=0;S.shareImports=0;S.importSharedMedia=async()=>{S.shareImports++;return [{uri:'file:///doc/imports/shared',name:'shared.wav',kind:'audio'}]};
  S.share={payloads:[],generation:'',error:null,consume(){},discardUnreadable(){S.discards++}};
}
async function mount(Component,props={}){let renderer;await act(async()=>{renderer=TestRenderer.create(React.createElement(Component,props))});return renderer}
function byLabel(tree,label){return tree.root.find(node=>node.props.accessibilityLabel===label)}
function allText(node){return node.findAll(n=>n.type==='Text').map(n=>n.children.filter(x=>typeof x==='string').join('')).join(' ')}
function buttonByText(tree,text){const found=tree.root.findAll(n=>(n.type==='TouchableOpacity'||n.type==='Pressable')&&allText(n).includes(text));assert.ok(found.length,`button containing ${text} not found`);return found[found.length-1]}
async function click(node){await act(async()=>{node.props.onPress?.()})}
async function unmount(tree){await act(async()=>tree.unmount())}
const originalError=console.error;console.error=(...args)=>{if(!String(args[0]).includes('react-test-renderer is deprecated'))originalError(...args)};
(async()=>{
  const Process=require(path.join(root,'src/app/processing/process.tsx')).default;
  const Recording=require(path.join(root,'src/app/recording/index.tsx')).default;
  const History=require(path.join(root,'src/app/history/index.tsx')).default;
  const Home=require(path.join(root,'src/app/(tabs)/index.tsx')).default;
  const ShareHandler=require(path.join(root,'src/app/share-handler.tsx')).default;
  const Compare=require(path.join(root,'src/components/CompareAudioPlayer.tsx')).default;
  const Slider=require(path.join(root,'src/components/customSlider.tsx')).default;
  const Bubble=require(path.join(root,'src/components/InfoBubble.tsx')).default;
  const Sidebar=require(path.join(root,'src/components/SettingsSidebar.tsx')).default;
  const Save=require(path.join(root,'src/components/SaveButton.tsx')).default;
  const Video=require(path.join(root,'src/components/videoPlayer.tsx')).default;

  reset();const loaded=deferred(), processing=deferred();S.getSettings=()=>loaded.promise;
  S.params={batch:encodeURIComponent(JSON.stringify([{uri:'file:///doc/imports/clip',name:'clip',kind:'audio'}]))};S.files.set('file:///doc/imports/clip',{size:100});
  let captured;S.processMedia=(...args)=>{captured=args;return processing.promise};
  let tree=await mount(Process);assert.equal(buttonByText(tree,'Loading settings…').props.disabled,true);
  await click(buttonByText(tree,'Loading settings…'));assert.equal(captured,undefined,'processing is gated before saved settings load');
  await act(async()=>loaded.resolve({...defaultSettings(),attenLimDb:20,attenPreset:'light'}));
  await click(buttonByText(tree,'Start denoising'));assert.equal(captured[3].attenLimDb,20);assert.equal(S.prevent.active,true);
  await act(async()=>S.prevent.callback());const stopAlert=S.alerts.find(x=>x[0]==='Processing in progress');assert.ok(stopAlert);
  await act(async()=>stopAlert[2].find(x=>x.text==='Stop processing').onPress());assert.equal(captured[4].cancelled,true);
  await act(async()=>processing.resolve({file:new FakeFile('file:///doc/denoised/out.wav'),seconds:1,cached:false,trimEnabled:false}));await unmount(tree);
  console.log('PASS processing waits for settings and hardware Back requests a safe stop');

  reset();const recSettings=deferred(), model=deferred();S.getSettings=()=>recSettings.promise;S.getDenoiser=()=>model.promise;
  tree=await mount(Recording);assert.equal(byLabel(tree,'Start recording').props.disabled,true);
  await act(async()=>model.resolve(denoiser));assert.equal(byLabel(tree,'Start recording').props.disabled,true);
  await act(async()=>recSettings.resolve({...defaultSettings(),attenLimDb:20,attenPreset:'light'}));
  assert.equal(byLabel(tree,'Start recording').props.disabled,false);
  S.nativeStart=async()=>{S.nativeIdle=false;S.files.set('file:///doc/recordings/test.wav',{size:100});return{fileUri:'file:///doc/recordings/test.wav'}};
  await click(byLabel(tree,'Start recording'));assert.equal(S.streamStrength,20);
  const originalBackup=[...S.files.keys()].find(x=>/orig_\d+\.pcm$/.test(x));assert.ok(originalBackup);S.files.get(originalBackup).size=10;
  S.nativeStop=async()=>{throw new Error('Stop rejected')};await click(byLabel(tree,'Stop and save recording'));
  assert.equal(S.prevent.active,true);assert.ok(buttonByText(tree,'Check recorder status'));
  await click(buttonByText(tree,'Check recorder status'));assert.ok(S.alerts.some(x=>x[0]==='Recorder status is still uncertain'));assert.equal(S.prevent.active,true);
  S.nativeIdle=true;await click(buttonByText(tree,'Check recorder status'));assert.equal(S.prevent.active,false);assert.ok(S.files.has(originalBackup));assert.ok(S.files.has('file:///doc/recordings/test.wav'));
  await click(buttonByText(tree,'Open Your files'));assert.equal(S.routes.at(-1),'/history');await unmount(tree);
  console.log('PASS failed Stop remains fail-closed until native writer checks succeed; recovery copies survive');

  reset();S.nativeStart=async()=>{S.nativeIdle=false;S.files.set('file:///doc/recordings/ambiguous.wav',{size:100});throw new Error('start promise rejected')};
  tree=await mount(Recording);await click(byLabel(tree,'Start recording'));assert.equal(S.prevent.active,true);
  assert.ok(buttonByText(tree,'Check recorder status'));assert.equal(S.ended,0,'model reservation remains while the writer is uncertain');
  await click(buttonByText(tree,'Check recorder status'));assert.equal(S.prevent.active,true);assert.ok(S.files.has('file:///doc/recordings/ambiguous.wav'));
  S.nativeIdle=true;await click(buttonByText(tree,'Check recorder status'));assert.equal(S.prevent.active,false);assert.equal(S.ended,1);assert.ok(S.files.has('file:///doc/recordings/ambiguous.wav'));await unmount(tree);
  console.log('PASS ambiguous native Start failure also remains fail-closed until writer verification');

  reset();const starting=deferred();S.nativeStart=()=>starting.promise;tree=await mount(Recording);
  await click(byLabel(tree,'Start recording'));assert.equal(byLabel(tree,'Start recording').props.disabled,true);assert.ok(allText(tree.root).includes('Starting…'));
  assert.equal(tree.root.findByType('CustomSlider').parent.props.pointerEvents,'none','settings are blocked while native start is pending');
  await act(async()=>starting.resolve({fileUri:'file:///doc/recordings/test.wav'}));await unmount(tree);
  console.log('PASS recording startup visibly disables settings and shows progress');

  reset();const pendingStart=deferred();let cleanupStops=0;S.nativeStart=()=>{S.nativeIdle=false;return pendingStart.promise};
  S.nativeStop=async()=>{cleanupStops++;S.nativeIdle=true;return{fileUri:'file:///doc/recordings/test.wav'}};
  tree=await mount(Recording);await click(byLabel(tree,'Start recording'));await unmount(tree);assert.equal(S.ended,0,'a pending native Start retains the model guard after unmount');
  await act(async()=>pendingStart.resolve({fileUri:'file:///doc/recordings/test.wav'}));assert.equal(cleanupStops,1);assert.equal(S.ended,1,'guard is released only after Stop and a successful writer check');

  reset();S.nativeStart=async()=>{S.nativeIdle=false;return{fileUri:'file:///doc/recordings/test.wav'}};S.nativeStop=async()=>{throw new Error('stop failed')};
  tree=await mount(Recording);await click(byLabel(tree,'Start recording'));const warn=console.warn;console.warn=()=>{};console.error=()=>{};await unmount(tree);console.warn=warn;console.error=(...args)=>{if(!String(args[0]).includes('react-test-renderer is deprecated'))originalError(...args)};
  assert.equal(S.ended,0,'failed Stop on unexpected unmount retains the active-run guard while a writer may remain active');
  console.log('PASS unexpected unmount waits for pending Start and remains fail-closed on Stop failure');

  reset();const bad=new FakeFile('file:///doc/recordings/empty.wav');S.files.set(bad.uri,{size:0});S.invalidRecording=true;
  S.privateMedia=[{file:bad,name:'empty.wav',group:'recordings',size:0,modified:0,video:false,kindKnown:true,partial:false}];
  tree=await mount(History);await click(buttonByText(tree,'Recordings'));assert.ok(allText(tree.root).includes('0 B'));
  await click(byLabel(tree,'empty.wav, 0 B'));assert.ok(allText(tree.root).includes('Cannot preview this file'));
  await click(byLabel(tree,'Delete empty.wav'));S.nativeIdle=false;await act(async()=>S.alerts.at(-1)[2].find(x=>x.text==='Delete').onPress());assert.ok(bad.exists,'active writer blocks deletion');
  S.nativeIdle=true;await click(byLabel(tree,'Delete empty.wav'));await act(async()=>S.alerts.at(-1)[2].find(x=>x.text==='Delete').onPress());assert.equal(bad.exists,false);await unmount(tree);
  console.log('PASS invalid recordings can be deleted only after native writer verification');

  reset();const legacy=new FakeFile('file:///doc/imports/voice.mp4');S.files.set(legacy.uri,{size:20});
  S.privateMedia=[{file:legacy,name:'voice.mp4',group:'imports',size:20,modified:0,video:true,kindKnown:false,partial:false}];
  tree=await mount(History);await click(buttonByText(tree,'Imports'));await click(byLabel(tree,'voice.mp4, 20 B'));
  assert.ok(allText(tree.root).includes('Choose the media type'));assert.equal(tree.root.findAllByType('VideoPlayer').length,0);assert.equal(tree.root.findAllByType('AudioPlayer').length,0);
  await click(buttonByText(tree,'Audio'));assert.equal(tree.root.findAllByType('AudioPlayer').length,1);await click(buttonByText(tree,'Denoise'));
  assert.equal(JSON.parse(decodeURIComponent(S.routes.at(-1).params.batch))[0].kind,'audio');
  await click(buttonByText(tree,'Video'));assert.equal(tree.root.findAllByType('VideoPlayer').length,1);await unmount(tree);
  console.log('PASS older imports require an explicit type and allow later correction');

  reset();S.audioStatus={orig:{isLoaded:true,error:null,currentTime:5,duration:100,playing:false},clean:{isLoaded:false,error:'decoder failed',currentTime:0,duration:0,playing:false}};
  tree=await mount(Compare,{originalUri:'orig',cleanedUri:'clean'});assert.ok(allText(tree.root).includes('Cleaned audio unavailable'));
  await click(buttonByText(tree,'Original'));assert.equal(byLabel(tree,'Play audio').props.disabled,false);await click(byLabel(tree,'Play audio'));assert.equal(S.plays,1);
  const timeline=byLabel(tree,'Audio playback position');await act(async()=>timeline.props.onAccessibilityAction({nativeEvent:{actionName:'increment'}}));assert.deepEqual(S.seeks,[10]);await unmount(tree);
  console.log('PASS surviving comparison track plays and accessible seeking works when the other fails');

  reset();const changed=[];tree=await mount(Slider,{label:'Strength',value:13,onValueChange:v=>changed.push(v),min:0,max:40,steps:[0,5,10,15,20,30,40]});
  const slider=byLabel(tree,'Strength');assert.equal(slider.props.style.height,48);await act(async()=>slider.props.onLayout({nativeEvent:{layout:{width:400}}}));
  await act(async()=>slider.props.onAccessibilityAction({nativeEvent:{actionName:'increment'}}));assert.equal(changed.at(-1),15);
  const gestureDetector=tree.root.findByType('GestureDetector');const tap=gestureDetector.props.gesture.items.find(x=>x.kind==='tap');await act(async()=>tap.callbacks.onEnd({x:200},true));assert.equal(changed.at(-1),15);await unmount(tree);
  tree=await mount(Bubble,{text:'Long help '.repeat(200),label:'Help for strength',children:React.createElement('Text',null,'?')});await click(byLabel(tree,'Help for strength'));
  assert.equal(tree.root.findByType('Modal').props.visible,true);const bubble=tree.root.find(n=>n.props.accessibilityViewIsModal===true);assert.equal(bubble.props.style[1].maxWidth,288);assert.equal(bubble.props.style[1].maxHeight,400);await unmount(tree);
  console.log('PASS sliders support taps, screen-reader actions and bounded scrollable help');

  reset();const firstSave=deferred();const updates=[];S.updateSettings=patch=>{updates.push(patch);return updates.length===1?firstSave.promise:Promise.resolve({...defaultSettings(),...patch})};
  tree=await mount(Sidebar,{visible:true,onClose:()=>{}});await click(buttonByText(tree,'CPU'));let autos=tree.root.findAll(n=>n.type==='TouchableOpacity'&&allText(n).trim()==='Auto');assert.equal(autos[0].props.disabled,true);
  await click(autos[0]);assert.equal(updates.length,1,'settings controls cannot race while saving');
  await act(async()=>firstSave.resolve({...defaultSettings(),runtime:'cpu'}));autos=tree.root.findAll(n=>n.type==='TouchableOpacity'&&allText(n).trim()==='Auto');await click(autos[0]);assert.deepEqual(updates.at(-1),{runtime:'auto'});assert.ok(buttonByText(tree,'About DeepDenoiser'));await unmount(tree);
  console.log('PASS settings saving serializes taps and exposes About');

  reset();const saving=deferred();let saveCalls=0;S.save=()=>{saveCalls++;return saving.promise};const file=new FakeFile('file:///doc/denoised/out.wav');S.files.set(file.uri,{size:4});
  tree=await mount(Save,{file,label:'Save'});await click(buttonByText(tree,'Save'));assert.equal(buttonByText(tree,'Saving…').props.disabled,true);await click(buttonByText(tree,'Saving…'));assert.equal(saveCalls,1);
  await act(async()=>saving.resolve('content://saved'));assert.ok(S.alerts.some(x=>x[0]==='Saved to device'&&x[1].includes('Music/DeepDenoiser Audio')));await unmount(tree);
  console.log('PASS saving shows progress, blocks duplicates and reports the destination');

  reset();S.save=async()=>{throw new Error('No space left on device')};tree=await mount(Save,{file,label:'Save'});
  await click(buttonByText(tree,'Save'));assert.ok(S.alerts.some(a=>a[0]==='Could not save'&&a[1].includes('No space left on device')));await unmount(tree);
  console.log('PASS saving reports the native failure cause');

  reset();tree=await mount(()=>React.createElement(React.Fragment,null,React.createElement(Video,{uri:'v1',name:'one'}),React.createElement(Video,{uri:'v2',name:'two'})));
  await act(async()=>S.videos.v1.emit('playingChange',{isPlaying:true}));assert.equal(S.videos.v2.pauses,1);
  await act(async()=>S.videos.v2.emit('playingChange',{isPlaying:true}));assert.equal(S.videos.v1.pauses,1);await unmount(tree);
  console.log('PASS starting one video pauses the other');

  reset();S.share.error=new Error('Provider failed');tree=await mount(Home);
  assert.equal(S.alerts.filter(a=>a[0]==='Could not read shared media').length,1);assert.equal(S.discards,0,'unreadable intents are not discarded before user confirmation');
  await click(buttonByText(tree,'Import media'));assert.equal(S.alerts.filter(a=>a[0]==='Could not read shared media').length,1,'rerenders do not repeat the error');
  await act(async()=>S.alerts[0][2][0].onPress());assert.equal(S.discards,1);await unmount(tree);
  reset();S.share.error=new Error('Provider failed');tree=await mount(ShareHandler);assert.equal(S.discards,0);
  await act(async()=>S.alerts[0][2][0].onPress());assert.equal(S.discards,1);assert.ok(S.routes.includes('/(tabs)'));await unmount(tree);
  console.log('PASS unreadable share errors wait for confirmation and avoid repeat alerts');

  reset();S.share={payloads:[{value:'content://a',shareType:'audio',mimeType:'audio/wav'}],generation:'1',error:null,consume(){},discardUnreadable(){}};
  S.focused=false;tree=await mount(Home);assert.equal(S.shareImports,0,'unfocused Home must not consume a queued share');
  S.focused=true;S.processingBusy=true;await act(async()=>tree.update(React.createElement(Home)));
  assert.equal(S.shareImports,0,'active recording/processing must defer a share');assert.ok(allText(tree.root).includes('Shared files are waiting'));
  S.processingBusy=false;await act(async()=>tree.update(React.createElement(Home)));
  assert.equal(S.shareImports,1);assert.equal(S.routes.filter(x=>x?.pathname==='/processing/process').length,1);
  await act(async()=>tree.update(React.createElement(Home)));assert.equal(S.shareImports,1,'queued share is not reimported while navigation takes focus');await unmount(tree);
  reset();S.processingBusy=true;S.share={payloads:[{value:'content://a',shareType:'audio',mimeType:'audio/wav'}],generation:'2',error:null,consume(){},discardUnreadable(){}};
  tree=await mount(ShareHandler);assert.equal(S.shareImports,0);assert.ok(allText(tree.root).includes('Shared files are waiting'));
  await click(buttonByText(tree,'Go back'));assert.equal(S.routes.at(-1),'back');await unmount(tree);
  console.log('PASS share handling waits for focus and active recording/processing before navigating');

  reset();S.pickDocument=async()=>({canceled:false,assets:Array.from({length:19},(_,i)=>({uri:`content://pick/${i}`,name:`item${i}.wav`,mimeType:'audio/wav'}))});
  tree=await mount(Home);await click(buttonByText(tree,'Import media'));assert.equal(tree.root.findAll(n=>typeof n.props.accessibilityLabel==='string'&&n.props.accessibilityLabel.startsWith('Remove item')).length,19);
  S.pickDocument=async()=>({canceled:false,assets:[{uri:'content://pick/0',name:'item0.wav',mimeType:'audio/wav'},{uri:'content://pick/19',name:'item19.wav',mimeType:'audio/wav'}]});
  await click(buttonByText(tree,'Add more files'));assert.equal(tree.root.findAll(n=>typeof n.props.accessibilityLabel==='string'&&n.props.accessibilityLabel.startsWith('Remove item')).length,20);assert.ok(!S.alerts.some(x=>x[0]==='Batch is full'));await unmount(tree);
  console.log('PASS picker limit counts distinct imported identities rather than raw selections');
})().catch(error=>{originalError(error);process.exitCode=1}).finally(()=>{Module._load=oldLoad;console.error=originalError});
