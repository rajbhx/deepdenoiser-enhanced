import AudioPlayer from "@/src/components/audioPlayer";
import CompareAudioPlayer from "@/src/components/CompareAudioPlayer";
import metadata from "@/assets/model/model_metadata.json";
import { placeOutput } from "@/src/scripts/denoiseCache";
import CustomSlider from "@/src/components/customSlider";
import ErrorModal from "@/src/components/ErrorModal";
import SaveButton from "@/src/components/SaveButton";
import ShareBtn from "@/src/components/shareBtn";
import SilenceTrimSettingsBlock from "@/src/components/silenceTrimSettings";
import * as theme from "@/src/constants/theme";
import { trackAppError, trackAppEvent } from "@/src/scripts/analytics";
import type { DeepFilterNet } from "@/src/scripts/Denoiser";
import { AlignedDenoiseStream } from "@/src/scripts/alignedDenoiseStream";
import { assertNativeRecorderIdle, BoundedRecordingQueue, ensureRecordingWavHeader, isRecordingFailureEvent, isRecordingWorkerFailed, reconcileRecording, RecordingHeaderMismatchError, recordingsDir, type RecordingQueueIssue } from "@/src/scripts/recordingSafety";
import { processMedia } from "@/src/scripts/processMedia";
import { beginRun, endRun, getDenoiser } from "@/src/scripts/denoiserSingleton";
import { recordDiagnostic, recordDiagnosticError } from "@/src/scripts/diagnostics";
import { PCMtoWav, writePCMChunk } from "@/src/scripts/formatHandler";
import {
  ATTEN_PRESET_DB,
  AttenPreset,
  getSettings,
  incrementDenoiseCount,
  updateSettings,
} from "@/src/scripts/settings";
import type { SilenceTrimSettings } from "@/src/scripts/silenceTrim";
import { DEFAULT_SILENCE_TRIM } from "@/src/scripts/silenceTrim";
import { Host, LoadingIndicator } from "@expo/ui/jetpack-compose";
import Feather from "@expo/vector-icons/Feather";
import {
  AudioDataEvent,
  AudioStudioModule,
  RecordingConfig,
  useAudioRecorder,
} from "@siteed/audio-studio";
import * as fs from "expo-file-system";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const SAMPLE_RATE = 48000;
const HOP_SIZE = metadata.hop_size;
const ALSTEPS = [0, 5, 10, 15, 20, 30, 40];
/** Mic emit interval (ms). 40ms = lower lag on OnePlus 7 when XNNPACK keeps up. */
const STREAM_INTERVAL_MS = 40;
/** Bound both the number and size of retained live events. */
const MAX_QUEUED_CHUNKS = 100;
const MAX_QUEUED_SAMPLES = SAMPLE_RATE * 4;

export default function RecordingScreen() {
  const router = useRouter();
  const {
    startRecording: startAudioRecording,
    stopRecording: stopAudioRecording,
    pauseRecording,
    resumeRecording,
    isRecording,
    isPaused,
    durationMs,
  } = useAudioRecorder();

  const [denoiserReady, setDenoiserReady] = useState(false);
  const [denoiserFailed, setDenoiserFailed] = useState(false);

  // We use refs for files to ensure the callback has immediate access to them
  // without waiting for a re-render or being trapped in a stale closure.
  const originalPcmFileRef = useRef<fs.File | null>(null);
  const denoisedPcmFileRef = useRef<fs.File | null>(null);

  const [finalOriginalWav, setFinalOriginalWav] = useState<fs.File | null>(
    null,
  );
  const [finalDenoisedWav, setFinalDenoisedWav] = useState<fs.File | null>(
    null,
  );
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [liveIssue, setLiveIssue] = useState<RecordingQueueIssue | null>(null);
  const [queueBehind, setQueueBehind] = useState(false);
  const [nativeFailure, setNativeFailure] = useState(false);
  // A failed Stop may leave the native writer open even after the hook reports idle.
  const [recorderUncertain, setRecorderUncertain] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [finalizingText, setFinalizingText] = useState("Finalizing Audio...");
  const [error, setError] = useState<Error | null>(null);
  const [isErrorModalVisible, setIsErrorModalVisible] = useState(false);
  const [attenLimDb, setAttenLimDb] = useState(0);
  const [settingsReady, setSettingsReady] = useState(false);
  const [attenPreset, setAttenPreset] = useState<AttenPreset>("max");
  const [silenceTrim, setSilenceTrim] =
    useState<SilenceTrimSettings>(DEFAULT_SILENCE_TRIM);

  useEffect(() => {
    let active = true;
    void getSettings().then((s) => {
      if (active) { setAttenLimDb(s.attenLimDb); setAttenPreset(s.attenPreset); }
    }).catch((err) => {
      if (active) { setError(new Error(`Could not load saved settings; using the default strength. ${err instanceof Error ? err.message : String(err)}`)); setIsErrorModalVisible(true); }
    }).finally(() => { if (active) setSettingsReady(true); });
    return () => { active = false; };
  }, []);

  const denoiserRef = useRef<DeepFilterNet | null>(null);
  const alignedRef = useRef<AlignedDenoiseStream | null>(null);
  const queueRef = useRef<BoundedRecordingQueue | null>(null);
  const modelInitInFlightRef = useRef(false);
  const nativeRecordingRef = useRef<fs.File | null>(null);
  const acceptingStreamRef = useRef(false);
  const runActiveRef = useRef(false);
  const isStoppingRef = useRef(false);
  const isStartingRef = useRef(false);
  const isRecordingRef = useRef(isRecording || isPaused);
  const nativeStartedRef = useRef(false);
  const nativeFailureRef = useRef(false);
  const mountedRef = useRef(true);
  const nativeStartPromiseRef = useRef<ReturnType<typeof startAudioRecording> | null>(null);
  const [pausedDuration, setPausedDuration] = useState(0);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const [pulseAnim] = useState(() => new Animated.Value(1));

  useEffect(() => {
    isRecordingRef.current = isRecording || isPaused;
  }, [isRecording, isPaused]);

  useEffect(() => {
    if (isPaused) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync pause timestamp for display
      setPausedDuration(durationMs);
    }
  }, [isPaused, durationMs]);

  const initDenoiser = async () => {
    if (modelInitInFlightRef.current) return;
    modelInitInFlightRef.current = true;
    try {
      const denoiser = await getDenoiser();
      if (!mountedRef.current) return;
      denoiserRef.current = denoiser;
      setDenoiserReady(true);
    } catch (err) {
      if (!mountedRef.current) return;
      console.error("Failed to init denoiser:", err);
      setDenoiserFailed(true);
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsErrorModalVisible(true);
    } finally { modelInitInFlightRef.current = false; }
  };

  useEffect(() => {
    mountedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- model readiness changes only after asynchronous loading
    void initDenoiser();

    return () => {
      // Ordinary Back/swipe navigation is prevented while recording. If the
      // screen is nevertheless destroyed, the native file lives in the durable
      // recordings folder and can be recovered from History on next launch.
      mountedRef.current = false;
      acceptingStreamRef.current = false;
      // A Stop/recovery operation already owns the writer and model lifetime.
      if (isStoppingRef.current) return;
      // If native Start is still pending, wait for it before asking Stop; a
      // premature idle check could otherwise miss a writer that starts later.
      const pendingStart = nativeStartPromiseRef.current;
      void (async () => {
        if (pendingStart) { try { await pendingStart; } catch { /* status decides safety */ } }
        const couldHaveWriter = !!pendingStart || isRecordingRef.current || nativeStartedRef.current;
        if (couldHaveWriter) {
          try { await stopAudioRecording(); } catch (err) { console.error("Failed to stop recording on unmount:", err); }
        }
        try { await queueRef.current?.drain(); } catch (err) { console.error("Failed to drain recording queue:", err); }
        if (couldHaveWriter) {
          try { assertNativeRecorderIdle(); nativeStartedRef.current = false; }
          catch {
            // Retain the active-run guard until process restart if native
            // liveness cannot be proved. Never touch recovery files here.
            console.warn("Recorder writer is uncertain after unmount; force-stop before recovery.");
            return;
          }
        }
        if (runActiveRef.current) { runActiveRef.current = false; endRun(); }
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: stop on unmount
  }, []);

  // The native error event is immediate when JS is running. This one-second
  // status check is a fallback if that event was missed while backgrounded.
  useEffect(() => {
    if ((!isRecording && !isPaused) || nativeFailure) return;
    const check = () => {
      if (isStoppingRef.current || !nativeRecordingRef.current) return;
      try {
        if (isRecordingWorkerFailed(AudioStudioModule.status(), nativeRecordingRef.current.uri)) {
          nativeFailureRef.current = true;
          setNativeFailure(true);
        }
      } catch { /* Keep the event path; do not claim success on status errors. */ }
    };
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [isRecording, isPaused, nativeFailure]);

  useEffect(() => {
    animRef.current?.stop();
    if (isRecording && !isPaused && !nativeFailure) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.5,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ]),
      );
      animRef.current = anim;
      anim.start();
    } else {
      pulseAnim.setValue(1);
    }
    return () => animRef.current?.stop();
  }, [isRecording, isPaused, nativeFailure, pulseAnim]);

  const handleAudioStream = async (event: AudioDataEvent) => {
    if (!acceptingStreamRef.current) return;
    const queue = queueRef.current;
    if (!queue || queue.overloaded || queue.error) return;
    if (!(event.data instanceof Float32Array)) {
      queue.fail(new Error("Recorder returned an unexpected stream format"));
      return;
    }
    if (event.data.length) queue.enqueue(event.data);
  };

  const startRecording = async () => {
    if (isStartingRef.current || isRecordingRef.current || recorderUncertain || recoveryReady || !settingsReady) return;
    isStartingRef.current = true;
    setIsStarting(true);
    recordDiagnostic("record", "record-start", "START");
    let nativeStartAttempted = false;
    try {
      if (!denoiserReady) {
        recordDiagnostic("record", "record-start", "CANCELLED");
        Alert.alert("Wait", "Denoiser is still initializing...");
        return;
      }
      const permission = await requestRecordingPermissionsAsync();
      if (!mountedRef.current) return;
      if (!permission.granted) {
        recordDiagnostic("record", "record-start", "FAIL_PERMISSION", "warning");
        Alert.alert("Microphone permission needed", "Allow microphone access to record your voice. You can still import files without it.");
        return;
      }
      assertNativeRecorderIdle();
      trackAppEvent("start_recording");
      // Initialize files
      const timestamp = Date.now();
      const origPcm = new fs.File(fs.Paths.cache, `orig_${timestamp}.pcm`);
      const denPcm = new fs.File(fs.Paths.cache, `den_${timestamp}.pcm`);

      await origPcm.create();
      await denPcm.create();
      if (!mountedRef.current) {
        for (const file of [origPcm, denPcm]) {
          try { if (file.exists && file.size === 0) file.delete(); } catch { /* best effort */ }
        }
        return;
      }

      originalPcmFileRef.current = origPcm;
      denoisedPcmFileRef.current = denPcm;

      setFinalOriginalWav(null);
      setFinalDenoisedWav(null);
      setLiveIssue(null);
      setQueueBehind(false);
      setNativeFailure(false);
      nativeFailureRef.current = false;
      isStoppingRef.current = false;
      nativeRecordingRef.current = null;
      if (queueRef.current) await queueRef.current.drain();

      // Reserve the shared model before creating a per-recording stream.
      if (!runActiveRef.current) { beginRun(); runActiveRef.current = true; }
      const denoiser = await getDenoiser();
      if (!mountedRef.current) {
        if (runActiveRef.current) { runActiveRef.current = false; endRun(); }
        for (const file of [origPcm, denPcm]) {
          try { if (file.exists && file.size === 0) file.delete(); } catch { /* best effort */ }
        }
        return;
      }
      denoiserRef.current = denoiser;
      const state = denoiser.createStream(attenLimDb);
      const aligned = new AlignedDenoiseStream(HOP_SIZE, metadata.algorithmic_delay_samples,
        (frame, output) => denoiser.processFrame(state, frame, output));
      alignedRef.current = aligned;
      let queue: BoundedRecordingQueue;
      queue = new BoundedRecordingQueue(MAX_QUEUED_CHUNKS, MAX_QUEUED_SAMPLES, async samples => {
        // Retain a byte-exact prefix for comparison with the native WAV.
        await writePCMChunk(origPcm, samples, true);
        const cleaned = await aligned.push(samples);
        if (cleaned.length) await writePCMChunk(denPcm, cleaned, true);
      }, issue => {
        if (mountedRef.current && queueRef.current === queue) setLiveIssue(issue);
      }, {
        thresholdSamples: SAMPLE_RATE / 2,
        onChange: behind => {
          if (mountedRef.current && queueRef.current === queue) setQueueBehind(behind);
        },
      });
      queueRef.current = queue;
      acceptingStreamRef.current = true;
      const dir = recordingsDir();
      // @siteed's Android API expects a filesystem path, not a file: URI.
      const outputDirectory = decodeURIComponent(dir.uri.replace(/^file:\/\//, ""));
      const recordingName = `recording_${timestamp}_${Math.random().toString(36).slice(2, 8)}_original`;
      // Set the expected URI before native Start: a worker can fail before the
      // Start promise resolves. Late events from older recordings are ignored.
      nativeRecordingRef.current = new fs.File(dir, `${recordingName}.wav`);

      const config: RecordingConfig = {
        sampleRate: SAMPLE_RATE,
        channels: 1,
        encoding: "pcm_16bit",
        interval: STREAM_INTERVAL_MS,
        outputDirectory,
        filename: recordingName,
        streamFormat: "float32",
        onAudioStream: handleAudioStream,
        onRecordingInterrupted: event => {
          if (!isStoppingRef.current && mountedRef.current && !nativeFailureRef.current &&
              isRecordingFailureEvent(event, nativeRecordingRef.current?.uri)) {
            nativeFailureRef.current = true;
            setNativeFailure(true);
          }
        },
        keepAwake: true,
        showNotification: false,
      };

      nativeStartAttempted = true;
      const nativeStart = startAudioRecording(config);
      nativeStartPromiseRef.current = nativeStart;
      const started = await nativeStart;
      nativeStartedRef.current = true;
      nativeRecordingRef.current = new fs.File(started.fileUri);
      isRecordingRef.current = true;
      recordDiagnostic("record", "record-start", "OK");
    } catch (error) {
      recordDiagnosticError("record", "record-start", error);
      acceptingStreamRef.current = false;
      if (!mountedRef.current) return; // unmount cleanup owns native liveness
      if (nativeStartedRef.current) {
        try { await stopAudioRecording(); nativeStartedRef.current = false; }
        catch { /* Verify writer liveness below rather than trusting the hook. */ }
      }
      await queueRef.current?.drain();
      let recorderIdle = true;
      if (nativeStartAttempted) {
        try { assertNativeRecorderIdle(); nativeStartedRef.current = false; }
        catch { recorderIdle = false; nativeStartedRef.current = true; setRecorderUncertain(true); }
      }
      // An empty failed-start scratch file has no recoverable audio.
      for (const file of [originalPcmFileRef.current, denoisedPcmFileRef.current]) {
        try { if (file?.exists && file.size === 0) file.delete(); } catch { /* best effort */ }
      }
      if (recorderIdle && runActiveRef.current) {
        runActiveRef.current = false;
        endRun();
      }
      const cause = error instanceof Error ? error : new Error(String(error));
      const err = recorderIdle ? cause : new Error(`The recorder may still be active. Check recorder status before recovery; if it cannot be confirmed, force-stop and reopen the app. ${cause.message}`);
      trackAppError(err, { context: "startRecording" });
      setError(err);
      setIsErrorModalVisible(true);
    } finally {
      nativeStartPromiseRef.current = null;
      isStartingRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  };

  const stopRecording = async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    recordDiagnostic("record", "record-stop", "START");
    let savedOriginal: fs.File | null = null;
    let nativeStopped = false;
    try {
      setIsFinalizing(true);
      setFinalizingText("Stopping microphone and closing recorder…");
      // Do not disable callbacks before native Stop: its final event can race
      // this promise. The WAV reconciliation below also covers late callbacks.
      const stopped = await stopAudioRecording();
      // A resolved JS promise alone does not prove the native writer is closed.
      assertNativeRecorderIdle();
      nativeStopped = true;
      nativeStartedRef.current = false;
      isRecordingRef.current = false;
      acceptingStreamRef.current = false;
      const queue = queueRef.current;
      setFinalizingText("Finishing queued live audio…");
      if (queue) await queue.drain();
      setFinalizingText("Checking the original recording…");
      const nativeWav = stopped?.fileUri ? new fs.File(stopped.fileUri) : nativeRecordingRef.current;
      if (!nativeWav?.exists || nativeWav.size <= 44) throw new Error("No audio was recorded. Please try again.");
      const totalBytes = ensureRecordingWavHeader(nativeWav);
      // This is the complete native file, already durable before denoising.
      savedOriginal = nativeWav;
      setFinalOriginalWav(nativeWav);

      const origPcm = originalPcmFileRef.current;
      const denPcm = denoisedPcmFileRef.current;
      const aligned = alignedRef.current;
      let matches = false;
      if (queue && !queue.error && origPcm && denPcm && aligned) {
        try {
          setFinalizingText("Checking recorded samples and finishing missing audio…");
          matches = await reconcileRecording(nativeWav, origPcm, async samples => {
            const cleaned = await aligned.push(samples);
            if (cleaned.length) await writePCMChunk(denPcm, cleaned, true);
          });
          if (matches) {
            setFinalizingText("Finishing cleaned audio…");
            const tail = await aligned.finish();
            if (tail.length) await writePCMChunk(denPcm, tail, true);
            if (denPcm.size !== totalBytes) throw new Error("Cleaned recording length does not match the original");
          }
        } catch (error) {
          console.warn("Live recording could not be reconciled; processing complete original:", error);
          matches = false;
        }
      }
      let savedDenoised: fs.File;
      if (matches && denPcm) {
        setFinalizingText("Preparing cleaned WAV…");
        const denWavResult = await PCMtoWav(denPcm, SAMPLE_RATE,
          silenceTrim.enabled ? silenceTrim : undefined);
        setFinalizingText("Saving cleaned WAV…");
        savedDenoised = await placeOutput(denWavResult.file, `recording_${Date.now()}_cleaned.wav`);
      } else {
        // A stream error or non-prefix gap must never silently corrupt output.
        // Reprocess the complete native recording instead.
        setFinalizingText("Denoising complete recording...");
        const result = await processMedia(nativeWav, nativeWav.name, false, {
          attenLimDb,
          normalize: { toggle: false, targetRMS: -14, maxPeakDb: -1 },
          silenceTrim,
        }, { cancelled: false }, p => setFinalizingText(`${p.stage} ${p.percent}%`));
        savedDenoised = result.file;
      }
      setFinalDenoisedWav(savedDenoised);
      recordDiagnostic("record", "record-stop", "OK");
    } catch (error) {
      recordDiagnosticError("record", "record-stop", error);
      acceptingStreamRef.current = false;
      setFinalizingText("Finishing queued audio for recovery…");
      await queueRef.current?.drain();
      if (!nativeStopped) {
        setRecorderUncertain(true);
        const cause = error instanceof Error ? error : new Error(String(error));
        setError(new Error(`The recorder could not be finalized. Audio may be missing. The original is kept in Your files. Check recorder status; if it cannot be confirmed, force-stop the app in Android settings and reopen it before recovery. ${cause.message}`));
        setIsErrorModalVisible(true);
      } else if (error instanceof RecordingHeaderMismatchError) {
        // Keep both the untouched native original and the streamed backup.
        setError(error);
        setIsErrorModalVisible(true);
      } else {
        // A streamed prefix is only a partial emergency copy. The native file
        // is also kept in Recordings for a later recovery attempt.
        let partialRecovery = false;
        const raw = originalPcmFileRef.current;
        if (!savedOriginal && raw?.exists && raw.size > 0) {
          try {
            const wav = (await PCMtoWav(raw, SAMPLE_RATE)).file;
            savedOriginal = await placeOutput(wav, `recording_${Date.now()}_partial_original.wav`);
            partialRecovery = true;
            setFinalOriginalWav(savedOriginal);
          } catch (recoveryError) { console.warn("Could not recover the partial streamed recording:", recoveryError); }
        }
        const cause = error instanceof Error ? error : new Error(String(error));
        const message = partialRecovery
          ? "A partial backup was kept. Check Your files for the complete native recording."
          : savedOriginal ? "The original was kept, but processing could not finish."
            : "Recording could not be finalized. Check Your files for a recoverable original.";
        const err = new Error(`${message} ${cause.message}`);
        trackAppError(err, { context: "stopRecording" });
        setError(err);
        setIsErrorModalVisible(true);
      }
    } finally {
      if (nativeStopped && runActiveRef.current) { runActiveRef.current = false; endRun(); }
      setIsFinalizing(false);
      isStoppingRef.current = false;
      if (nativeStopped) for (const file of [originalPcmFileRef.current, denoisedPcmFileRef.current]) {
        // Keep the streamed prefix if no durable original could be recovered.
        if (file === originalPcmFileRef.current && !savedOriginal) continue;
        try { if (file?.exists) file.delete(); } catch (err) { console.warn("Could not remove recording scratch file:", err); }
      }
      if (nativeStopped) {
        originalPcmFileRef.current = null;
        denoisedPcmFileRef.current = null;
        alignedRef.current = null;
        queueRef.current = null;
      }
    }
  };

  const checkRecorderStatus = async () => {
    if (isStoppingRef.current || isStartingRef.current) return;
    isStoppingRef.current = true;
    setIsFinalizing(true);
    setFinalizingText("Checking recorder status...");
    try {
      // The hook can report idle after a failed Stop while native still writes.
      // Verify the native writer, drain accepted callbacks, then verify again.
      assertNativeRecorderIdle();
      acceptingStreamRef.current = false;
      await queueRef.current?.drain();
      assertNativeRecorderIdle();
      nativeStartedRef.current = false;
      isRecordingRef.current = false;
      if (runActiveRef.current) { runActiveRef.current = false; endRun(); }
      // Do not inspect, repair or remove any recording here. Both the durable
      // native WAV and any streamed prefix remain available in Your files.
      setRecoveryReady(true);
      setRecorderUncertain(false);
    } catch (statusError) {
      const message = statusError instanceof Error ? statusError.message : String(statusError);
      Alert.alert("Recorder status is still uncertain", `${message} Force-stop the app in Android settings and reopen Your files before attempting recovery.`);
    } finally {
      isStoppingRef.current = false;
      setIsFinalizing(false);
    }
  };

  usePreventRemove((!recoveryReady && (isRecording || isPaused)) || isFinalizing || isStarting || recorderUncertain, () => {
    if (recorderUncertain) {
      Alert.alert("Recorder needs recovery", "Force-stop the app in Android settings, then reopen Your files. The original recording was kept.");
      return;
    }
    if (isFinalizing || isStarting) {
      Alert.alert("Please wait", isStarting ? "Starting the recorder…" : finalizingText);
      return;
    }
    Alert.alert(nativeFailure ? "Recording stopped unexpectedly" : "Recording in progress", nativeFailure
      ? "Audio may be missing. Stop the recorder to preserve what was captured before leaving."
      : "Stop and save this recording before leaving?", [
      { text: nativeFailure ? "Stay here" : "Keep recording", style: "cancel" },
      { text: "Stop and save", onPress: () => { void stopRecording(); } },
    ]);
  });

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  useEffect(() => {
    if (!finalDenoisedWav) return;
    (async () => {
      await incrementDenoiseCount().catch((err) => console.warn("Could not update processing count:", err));
    })();
  }, [finalDenoisedWav]);

  return (
    <SafeAreaView style={theme.Styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.backButton,
            { opacity: pressed ? 0.7 : 1 },
          ]}
          disabled={isFinalizing || isStarting}
          android_ripple={{
            color: "rgba(255, 255, 255, 0.1)",
            borderless: true,
            radius: 24,
          }}
        >
          <Feather name="arrow-left" size={24} color={theme.COLORS.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Voice Recorder</Text>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {!finalOriginalWav && !isFinalizing && !recorderUncertain && !recoveryReady && (
          <View style={[styles.timerContainer, (isRecording || isPaused) && styles.timerContainerActive]}>
            <Text style={[styles.timerText, (isRecording || isPaused) && styles.timerTextActive]}>
              {formatTime(isPaused ? pausedDuration : (durationMs ?? 0))}
            </Text>
            {isRecording && !isPaused && !nativeFailure && (
              <View style={styles.recordingIndicator}>
                <Animated.View
                  style={[
                    styles.pulseCircle,
                    { transform: [{ scale: pulseAnim }] },
                  ]}
                />
                <View style={styles.recordingDot} />
              </View>
            )}
          </View>
        )}

        {isFinalizing ? (
          <View style={styles.finalizingContainer}>
            <Host matchContents style={{ width: 48, height: 48 }} colorScheme="dark">
              <LoadingIndicator color={theme.COLORS.primary} />
            </Host>
            <Text style={styles.statusText}>{finalizingText}</Text>
          </View>
        ) : recorderUncertain ? (
          <View style={styles.recoveryContainer}>
            <Text style={styles.recoveryTitle}>Recorder status needs checking</Text>
            <Text style={styles.recoveryText}>The recorder may still be writing. Check its status before accessing the original or partial backup. If the status cannot be confirmed, force-stop the app in Android settings and reopen it.</Text>
            <TouchableOpacity accessibilityRole="button" style={[theme.Styles.button, styles.recoveryButton]} onPress={() => void checkRecorderStatus()}>
              <Text style={theme.Styles.buttonText}>Check recorder status</Text>
            </TouchableOpacity>
          </View>
        ) : recoveryReady ? (
          <View style={styles.recoveryContainer}>
            <Text style={styles.recoveryTitle}>Recorder confirmed stopped</Text>
            <Text style={styles.recoveryText}>Open Your files to inspect the original recording and any partial backup. Nothing was deleted by the status check.</Text>
            <TouchableOpacity accessibilityRole="button" style={[theme.Styles.button, styles.recoveryButton]} onPress={() => router.replace("/history")}>
              <Text style={theme.Styles.buttonText}>Open Your files</Text>
            </TouchableOpacity>
          </View>
        ) : !finalOriginalWav ? (
          <View style={styles.controlsContainer}>
            <Text accessibilityLiveRegion="polite" style={[styles.statusText, (isRecording || isPaused) && styles.activeStatusText]}>
              {nativeFailure ? "Recording stopped unexpectedly" : !settingsReady ? "Loading saved settings…" : denoiserFailed ? "Denoiser unavailable" : !denoiserReady ? "Preparing denoiser…" : !isRecording && !isPaused
                ? "Ready to record"
                : isPaused ? "Recording paused"
                  : liveIssue ? "Recording · live cleaning interrupted" : "Recording"}
            </Text>

            {denoiserFailed && !isRecording && !isPaused && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry preparing denoiser"
                style={styles.retryModelButton} onPress={() => { setDenoiserFailed(false); setDenoiserReady(false); void initDenoiser(); }}>
                <Text style={styles.retryModelText}>Retry denoiser</Text>
              </TouchableOpacity>
            )}
            {isStarting && <Host matchContents colorScheme="dark"><LoadingIndicator color={theme.COLORS.primary} /></Host>}

            {nativeFailure && (isRecording || isPaused) && (
              <View style={styles.queueWarning} accessibilityLiveRegion="assertive">
                <Feather name="alert-circle" size={18} color={theme.COLORS.error} />
                <Text style={styles.queueWarningText}>The recorder stopped capturing audio. Some audio may be missing. Tap Stop to preserve the original and check recovery.</Text>
              </View>
            )}
            {!nativeFailure && (isRecording || isPaused) && (liveIssue || queueBehind) && (
              <View style={styles.queueWarning} accessibilityLiveRegion="polite">
                <Feather name="alert-circle" size={18} color={theme.COLORS.error} />
                <Text style={styles.queueWarningText}>
                  {liveIssue === "error" ? "Live cleaning stopped. The app will try to finish after Stop."
                    : liveIssue === "overloaded" ? "Live queue is full. The app will try to finish after Stop."
                      : isPaused ? "Microphone paused; finishing queued audio."
                        : "Live cleaning is behind the microphone. The app will try to catch up."}
                </Text>
              </View>
            )}

            {!isRecording && !isPaused ? (
              <View style={[styles.sliderContainer, (!settingsReady || isStarting) && { opacity: 0.6 }]}
                pointerEvents={!settingsReady || isStarting ? "none" : "auto"}
                importantForAccessibility={!settingsReady || isStarting ? "no-hide-descendants" : "auto"}>
                <Text style={styles.presetLabel}>Strength</Text>
                <View style={styles.presetRow}>
                  {([
                    ["max", "Max"],
                    ["strong", "Strong"],
                    ["medium", "Med"],
                    ["light", "Light"],
                  ] as [Exclude<AttenPreset, "custom">, string][]).map(([id, label]) => {
                    const on = attenPreset === id;
                    return (
                      <TouchableOpacity
                        key={id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        style={[styles.presetChip, on && styles.presetChipOn]}
                        onPress={async () => {
                          setAttenPreset(id);
                          setAttenLimDb(ATTEN_PRESET_DB[id]);
                          try { await updateSettings({ attenPreset: id }); }
                          catch (err) { setError(err instanceof Error ? err : new Error(String(err))); setIsErrorModalVisible(true); }
                        }}
                      >
                        <Text style={[styles.presetChipText, on && styles.presetChipTextOn]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <CustomSlider
                  label="Clean/original mix (dB)"
                  value={attenLimDb}
                  onValueChange={async (v) => {
                    setAttenLimDb(v);
                    setAttenPreset("custom");
                    try { await updateSettings({ attenLimDb: v, attenPreset: "custom" }); }
                    catch (err) { setError(err instanceof Error ? err : new Error(String(err))); setIsErrorModalVisible(true); }
                  }}
                  min={0}
                  max={40}
                  steps={ALSTEPS}
                  info={`Blends cleaned and time-aligned original audio: 0 dB = 100% cleaned, 20 dB ≈ 10%, 40 dB ≈ 1%. This is not a measured noise-reduction level.`}
                />

                <View style={styles.settingsDivider} />

                <SilenceTrimSettingsBlock
                  settings={silenceTrim}
                  onChange={setSilenceTrim}
                />
              </View>
            ) : null}

            {!isRecording && !isPaused ? (
              <Pressable
                style={({ pressed }) => [
                  styles.recordButton,
                  { opacity: pressed ? 0.9 : 1 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Start recording"
                accessibilityState={{ disabled: !settingsReady || !denoiserReady || isStarting }}
                onPress={startRecording}
                disabled={!settingsReady || !denoiserReady || isStarting}
                android_ripple={{
                  color: "rgba(255, 255, 255, 0.2)",
                  borderless: true,
                  radius: 70,
                }}
              >
                <View style={styles.recordButtonInner}>
                  <Feather name="mic" size={40} color={theme.COLORS.white} />
                </View>
                <Text style={styles.buttonLabel}>{denoiserFailed ? "Model unavailable" : !settingsReady || !denoiserReady ? "Preparing…" : isStarting ? "Starting…" : "Tap to Start"}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={styles.resultsContainer}>
            <View style={styles.resultCard}>
              <Text style={styles.resultTitle}>{finalDenoisedWav ? "Recording ready" : "Original ready"}</Text>
              <Text style={styles.resultHint}>Save a copy to your device or share it.</Text>
              {finalDenoisedWav && !silenceTrim.enabled ? (
                <CompareAudioPlayer key={`${finalOriginalWav.uri}|${finalDenoisedWav.uri}`}
                  originalUri={finalOriginalWav.uri} cleanedUri={finalDenoisedWav.uri} />
              ) : (
                <>
                  <Text style={styles.trackLabel}>Original</Text>
                  <AudioPlayer uri={finalOriginalWav.uri} name="Original recording" />
                  {finalDenoisedWav && <>
                    <Text style={styles.trackLabel}>Cleaned</Text>
                    <AudioPlayer uri={finalDenoisedWav.uri} name="Denoised recording" />
                    <Text style={styles.trimHint}>Silence trimming changes the timeline, so play each track separately.</Text>
                  </>}
                </>
              )}
              <View style={styles.resultActions}>
                <SaveButton file={finalOriginalWav} label="Save original" savedLabel="Original saved" savingLabel="Saving original"
                  albumName="DeepDenoiser Recordings" style={[theme.Styles.button, styles.saveSubButton]}
                  onError={(err) => { setError(err); setIsErrorModalVisible(true); }} />
                <ShareBtn uri={finalOriginalWav.uri} accessibilityLabel="Share original recording" />
              </View>
              {finalDenoisedWav && <View style={styles.resultActions}>
                <SaveButton file={finalDenoisedWav} label="Save cleaned" savedLabel="Cleaned saved" savingLabel="Saving cleaned"
                  albumName="DeepDenoiser Recordings" style={[theme.Styles.button, styles.saveSubButton]}
                  onError={(err) => { setError(err); setIsErrorModalVisible(true); }} />
                <ShareBtn uri={finalDenoisedWav.uri} accessibilityLabel="Share cleaned recording" />
              </View>}
            </View>
            <TouchableOpacity accessibilityRole="button" style={[theme.Styles.button, styles.newRecordButton]}
              onPress={() => { setFinalOriginalWav(null); setFinalDenoisedWav(null); }}>
              <Feather name="refresh-cw" size={18} color={theme.COLORS.primary} />
              <Text style={[theme.Styles.buttonText, { color: theme.COLORS.primary }]}>Record New</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {(isRecording || isPaused) && !isFinalizing && !recorderUncertain && !recoveryReady && !finalOriginalWav && (
        <View style={styles.fixedControls}>
          <View style={styles.controlGroup}>
            <Pressable
              disabled={nativeFailure}
              accessibilityState={{ disabled: nativeFailure }}
              style={({ pressed }) => [styles.controlCircle, { backgroundColor: "rgba(255, 255, 255, 0.1)", opacity: pressed ? 0.7 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel={isPaused ? "Resume recording" : "Pause recording"}
              onPress={isPaused ? resumeRecording : pauseRecording}
              android_ripple={{ color: "rgba(255, 255, 255, 0.2)", borderless: true, radius: 32 }}
            >
              <Feather name={isPaused ? "play" : "pause"} size={28} color={theme.COLORS.text} />
            </Pressable>
            <Text style={styles.controlLabel}>{isPaused ? "Resume" : "Pause"}</Text>
          </View>
          <View style={styles.controlGroup}>
            <Pressable
              style={({ pressed }) => [styles.stopButton, { opacity: pressed ? 0.8 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel="Stop and save recording"
              onPress={stopRecording}
              android_ripple={{ color: "rgba(255, 255, 255, 0.2)", borderless: true, radius: 40 }}
            >
              <View style={styles.stopButtonInner}>
                <Feather name="square" size={28} color={theme.COLORS.white} />
              </View>
            </Pressable>
            <Text style={styles.controlLabel}>Stop</Text>
          </View>
        </View>
      )}

      <ErrorModal
        context="record"
        visible={isErrorModalVisible}
        error={error}
        onClose={() => setIsErrorModalVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  presetLabel: {
    color: theme.COLORS.subtext,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 8,
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 16,
  },
  presetChip: {
    minHeight: 44,
    justifyContent: "center",
    marginBottom: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginRight: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.COLORS.border,
  },
  presetChipOn: {
    backgroundColor: theme.COLORS.primary,
    borderColor: theme.COLORS.primary,
  },
  presetChipText: {
    color: theme.COLORS.text,
    fontWeight: "600",
    fontSize: 12,
  },
  presetChipTextOn: {
    color: theme.COLORS.background,
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.SPACING.medium,
    justifyContent: "center",
    height: 60,
  },
  headerTitle: {
    color: theme.COLORS.text,
    fontSize: theme.FONT_SIZE.heading,
    fontWeight: "800",
  },
  backButton: {
    position: "absolute",
    left: theme.SPACING.medium,
    padding: 8,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    alignItems: "center",
    paddingBottom: 100,
    // paddingHorizontal: theme.SPACING.medium,
  },
  timerContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 60,
    marginBottom: 20,
    height: 100,
  },
  timerContainerActive: { marginTop: 8, marginBottom: 4, height: 62 },
  timerText: {
    fontSize: 72,
    fontWeight: "200",
    color: theme.COLORS.text,
    fontVariant: ["tabular-nums"],
    letterSpacing: -2,
  },
  timerTextActive: { fontSize: 46, letterSpacing: -1 },
  recordingIndicator: {
    marginLeft: 20,
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
  },
  pulseCircle: {
    position: "absolute",
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.COLORS.error,
    opacity: 0.3,
  },
  recordingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.COLORS.error,
  },
  statusText: {
    color: theme.COLORS.subtext,
    fontSize: theme.FONT_SIZE.body,
    marginBottom: 40,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 2,
  },
  activeStatusText: { marginBottom: 10, textTransform: "none", letterSpacing: 0, textAlign: "center" },
  queueWarning: { width: "100%", flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 14, marginBottom: 16, borderRadius: 12, backgroundColor: "rgba(239,68,68,0.12)" },
  queueWarningText: { color: theme.COLORS.text, flex: 1, fontSize: 13, lineHeight: 19 },
  retryModelButton: { minHeight: 48, paddingHorizontal: 20, justifyContent: "center", borderWidth: 1, borderColor: theme.COLORS.primary, borderRadius: 12, marginBottom: 16 },
  retryModelText: { color: theme.COLORS.primary, fontSize: 14, fontWeight: "700" },
  controlsContainer: {
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
  },
  recoveryContainer: { width: "100%", gap: 16, padding: 20, backgroundColor: theme.COLORS.surface, borderRadius: 18, marginTop: 30 },
  recoveryTitle: { color: theme.COLORS.text, fontSize: 19, fontWeight: "800" },
  recoveryText: { color: theme.COLORS.subtext, fontSize: 14, lineHeight: 22 },
  recoveryButton: { minHeight: 48, paddingHorizontal: 16 },
  finalizingContainer: {
    alignItems: "center",
    justifyContent: "center",
    marginTop: 100,
    gap: 20,
  },
  sliderContainer: {
    width: "100%",
    paddingHorizontal: theme.SPACING.medium,
    marginBottom: 40,
  },

  settingsDivider: {
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    marginVertical: 15,
  },
  recordButton: {
    alignItems: "center",
  },
  recordButtonInner: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: theme.COLORS.error,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: theme.COLORS.error,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
  buttonLabel: {
    color: theme.COLORS.subtext,
    marginTop: 24,
    fontSize: theme.FONT_SIZE.body,
    fontWeight: "700",
  },
  fixedControls: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 48,
    paddingTop: 8, paddingBottom: 8, borderTopWidth: 1, borderTopColor: theme.COLORS.border,
    backgroundColor: theme.COLORS.background,
  },
  controlGroup: { alignItems: "center", gap: 4 },
  controlLabel: { color: theme.COLORS.subtext, fontSize: 12, fontWeight: "700" },
  controlCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.COLORS.border,
  },
  stopButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: theme.COLORS.error,
  },
  stopButtonInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.COLORS.error,
    alignItems: "center",
    justifyContent: "center",
  },
  resultsContainer: { width: "100%", marginTop: 20 },
  resultCard: { backgroundColor: theme.COLORS.surface, borderRadius: 18, padding: 18, borderWidth: 1, borderColor: theme.COLORS.border },
  resultTitle: { color: theme.COLORS.text, fontSize: 19, fontWeight: "800" },
  resultHint: { color: theme.COLORS.subtext, fontSize: 13, lineHeight: 19, marginTop: 4, marginBottom: 18 },
  trackLabel: { color: theme.COLORS.text, fontSize: 13, fontWeight: "700", marginTop: 12, marginBottom: 4 },
  trimHint: { color: theme.COLORS.subtext, fontSize: 12, lineHeight: 18, marginTop: 8 },
  resultActions: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 },
  saveSubButton: { flex: 1, height: 50, borderRadius: 12, paddingHorizontal: 8 },
  newRecordButton: { marginTop: 18, backgroundColor: "transparent", borderWidth: 1, borderColor: theme.COLORS.primary, height: 52, borderRadius: 12, gap: 10 },
});
