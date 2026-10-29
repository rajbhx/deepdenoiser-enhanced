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
import { BoundedRecordingQueue, ensureRecordingWavHeader, reconcileRecording, recordingsDir } from "@/src/scripts/recordingSafety";
import { processMedia } from "@/src/scripts/processMedia";
import { beginRun, endRun, getDenoiser } from "@/src/scripts/denoiserSingleton";
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
  const [isCatchingUp, setIsCatchingUp] = useState(false);
  const [finalizingText, setFinalizingText] = useState("Finalizing Audio...");
  const [error, setError] = useState<Error | null>(null);
  const [isErrorModalVisible, setIsErrorModalVisible] = useState(false);
  const [attenLimDb, setAttenLimDb] = useState(0);
  const [attenPreset, setAttenPreset] = useState<AttenPreset>("max");
  const [silenceTrim, setSilenceTrim] =
    useState<SilenceTrimSettings>(DEFAULT_SILENCE_TRIM);

  useEffect(() => {
    let active = true;
    void getSettings().then((s) => {
      if (active) { setAttenLimDb(s.attenLimDb); setAttenPreset(s.attenPreset); }
    }).catch((err) => console.warn("Could not load recording settings:", err));
    return () => { active = false; };
  }, []);

  const denoiserRef = useRef<DeepFilterNet | null>(null);
  const alignedRef = useRef<AlignedDenoiseStream | null>(null);
  const queueRef = useRef<BoundedRecordingQueue | null>(null);
  const nativeRecordingRef = useRef<fs.File | null>(null);
  const acceptingStreamRef = useRef(false);
  const runActiveRef = useRef(false);
  const isStoppingRef = useRef(false);
  const isStartingRef = useRef(false);
  const isRecordingRef = useRef(isRecording);
  const [pausedDuration, setPausedDuration] = useState(0);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const [pulseAnim] = useState(() => new Animated.Value(1));

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    if (isPaused) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync pause timestamp for display
      setPausedDuration(durationMs);
    }
  }, [isPaused, durationMs]);

  useEffect(() => {
    const initDenoiser = async () => {
      try {
        const denoiser = await getDenoiser();
        denoiserRef.current = denoiser;
        setDenoiserReady(true);
      } catch (err) {
        console.error("Failed to init denoiser:", err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsErrorModalVisible(true);
      }
    };
    initDenoiser();

    return () => {
      // Ordinary Back/swipe navigation is prevented while recording. If the
      // screen is nevertheless destroyed, the native file lives in the durable
      // recordings folder and can be recovered from History on next launch.
      acceptingStreamRef.current = false;
      const stop = isRecordingRef.current ? stopAudioRecording() : Promise.resolve();
      void stop.catch((err) => console.error("Failed to stop recording on unmount:", err))
        .then(() => queueRef.current?.drain())
        .catch((err) => console.error("Failed to drain recording queue:", err))
        .finally(() => {
          if (runActiveRef.current) { runActiveRef.current = false; endRun(); }
        });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: stop on unmount
  }, []);

  useEffect(() => {
    animRef.current?.stop();
    if (isRecording && !isPaused) {
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
  }, [isRecording, isPaused, pulseAnim]);

  const handleAudioStream = async (event: AudioDataEvent) => {
    if (!acceptingStreamRef.current) return;
    const queue = queueRef.current;
    if (!queue || queue.overloaded || queue.error) return;
    if (!(event.data instanceof Float32Array)) {
      queue.error = new Error("Recorder returned an unexpected stream format");
      setIsCatchingUp(true);
      return;
    }
    if (event.data.length && !queue.enqueue(event.data)) setIsCatchingUp(true);
  };

  const startRecording = async () => {
    if (isStartingRef.current || isRecordingRef.current) return;
    isStartingRef.current = true;
    setIsStarting(true);
    try {
      if (!denoiserReady) {
        Alert.alert("Wait", "Denoiser is still initializing...");
        return;
      }
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Microphone permission needed", "Allow microphone access to record your voice. You can still import files without it.");
        return;
      }
      trackAppEvent("start_recording");
      // Initialize files
      const timestamp = Date.now();
      const origPcm = new fs.File(fs.Paths.cache, `orig_${timestamp}.pcm`);
      const denPcm = new fs.File(fs.Paths.cache, `den_${timestamp}.pcm`);

      await origPcm.create();
      await denPcm.create();

      originalPcmFileRef.current = origPcm;
      denoisedPcmFileRef.current = denPcm;

      setFinalOriginalWav(null);
      setFinalDenoisedWav(null);
      setIsCatchingUp(false);
      isStoppingRef.current = false;
      nativeRecordingRef.current = null;
      if (queueRef.current) await queueRef.current.drain();

      // Reserve the shared model before creating a per-recording stream.
      if (!runActiveRef.current) { beginRun(); runActiveRef.current = true; }
      const denoiser = await getDenoiser();
      denoiserRef.current = denoiser;
      const state = denoiser.createStream(attenLimDb);
      const aligned = new AlignedDenoiseStream(HOP_SIZE, metadata.algorithmic_delay_samples,
        frame => denoiser.processFrame(state, frame));
      alignedRef.current = aligned;
      queueRef.current = new BoundedRecordingQueue(MAX_QUEUED_CHUNKS, MAX_QUEUED_SAMPLES, async samples => {
        // Retain a byte-exact prefix for comparison with the native WAV.
        await writePCMChunk(origPcm, samples, true);
        const cleaned = await aligned.push(samples);
        if (cleaned.length) await writePCMChunk(denPcm, cleaned, true);
      });
      acceptingStreamRef.current = true;
      const dir = recordingsDir();
      // @siteed's Android API expects a filesystem path, not a file: URI.
      const outputDirectory = decodeURIComponent(dir.uri.replace(/^file:\/\//, ""));
      const recordingName = `recording_${timestamp}_${Math.random().toString(36).slice(2, 8)}_original`;

      const config: RecordingConfig = {
        sampleRate: SAMPLE_RATE,
        channels: 1,
        encoding: "pcm_16bit",
        interval: STREAM_INTERVAL_MS,
        outputDirectory,
        filename: recordingName,
        streamFormat: "float32",
        onAudioStream: handleAudioStream,
        keepAwake: true,
        showNotification: false,
      };

      const started = await startAudioRecording(config);
      nativeRecordingRef.current = new fs.File(started.fileUri);
      isRecordingRef.current = true;
    } catch (error) {
      acceptingStreamRef.current = false;
      await queueRef.current?.drain();
      // An empty failed-start scratch file has no recoverable audio.
      for (const file of [originalPcmFileRef.current, denoisedPcmFileRef.current]) {
        try { if (file?.exists && file.size === 0) file.delete(); } catch { /* best effort */ }
      }
      if (runActiveRef.current) {
        runActiveRef.current = false;
        endRun();
      }
      const err = error instanceof Error ? error : new Error(String(error));
      trackAppError(err, { context: "startRecording" });
      setError(err);
      setIsErrorModalVisible(true);
    } finally {
      isStartingRef.current = false;
      setIsStarting(false);
    }
  };

  const stopRecording = async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    let savedOriginal: fs.File | null = null;
    let nativeStopped = false;
    try {
      setIsFinalizing(true);
      setFinalizingText("Stopping recorder...");
      // Do not disable callbacks before native Stop: its final event can race
      // this promise. The WAV reconciliation below also covers late callbacks.
      const stopped = await stopAudioRecording();
      nativeStopped = true;
      isRecordingRef.current = false;
      acceptingStreamRef.current = false;
      const queue = queueRef.current;
      if (queue) await queue.drain();
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
          setFinalizingText("Checking recording and finishing audio...");
          matches = await reconcileRecording(nativeWav, origPcm, async samples => {
            const cleaned = await aligned.push(samples);
            if (cleaned.length) await writePCMChunk(denPcm, cleaned, true);
          });
          if (matches) {
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
        const denWavResult = await PCMtoWav(denPcm, SAMPLE_RATE,
          silenceTrim.enabled ? silenceTrim : undefined);
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
    } catch (error) {
      acceptingStreamRef.current = false;
      await queueRef.current?.drain();
      if (!nativeStopped) {
        const cause = error instanceof Error ? error : new Error(String(error));
        setError(new Error(`Could not stop the recorder. Try Stop again or restart the app; the native recording is kept for recovery in Your files. ${cause.message}`));
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

  usePreventRemove(isRecording || isFinalizing || isStarting, () => {
    if (isFinalizing || isStarting) {
      Alert.alert("Please wait", "Your recording is being prepared or saved.");
      return;
    }
    Alert.alert("Recording in progress", "Stop and save this recording before leaving?", [
      { text: "Keep recording", style: "cancel" },
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
        {!finalOriginalWav && !isFinalizing && (
          <View style={styles.timerContainer}>
            <Text style={styles.timerText}>
              {formatTime(isPaused ? pausedDuration : (durationMs ?? 0))}
            </Text>
            {isRecording && !isPaused && (
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
        ) : !finalOriginalWav ? (
          <View style={styles.controlsContainer}>
            <Text style={styles.statusText}>
              {!isRecording && !isPaused
                ? "Ready to record"
                : isPaused
                  ? "Recording paused"
                  : isCatchingUp ? "Recording safely — denoising will finish after stop" : "Denoising in Real-time"}
            </Text>

            {!isRecording && !isPaused ? (
              <View style={styles.sliderContainer}>
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
                  label="Fine tune (dB)"
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
                  info={`0dB = strongest denoise. Higher keeps more ambient sound.`}
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
                onPress={startRecording}
                android_ripple={{
                  color: "rgba(255, 255, 255, 0.2)",
                  borderless: true,
                  radius: 70,
                }}
              >
                <View style={styles.recordButtonInner}>
                  <Feather name="mic" size={40} color={theme.COLORS.white} />
                </View>
                <Text style={styles.buttonLabel}>Tap to Start</Text>
              </Pressable>
            ) : (
              <View style={styles.activeControls}>
                <Pressable
                  style={({ pressed }) => [
                    styles.controlCircle,
                    {
                      backgroundColor: "rgba(255, 255, 255, 0.1)",
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                  onPress={isPaused ? resumeRecording : pauseRecording}
                  android_ripple={{
                    color: "rgba(255, 255, 255, 0.2)",
                    borderless: true,
                    radius: 32,
                  }}
                >
                  <Feather
                    name={isPaused ? "play" : "pause"}
                    size={28}
                    color={theme.COLORS.text}
                  />
                </Pressable>

                <Pressable
                  style={({ pressed }) => [
                    styles.stopButton,
                    { opacity: pressed ? 0.8 : 1 },
                  ]}
                  onPress={stopRecording}
                  android_ripple={{
                    color: "rgba(255, 255, 255, 0.2)",
                    borderless: true,
                    radius: 50,
                  }}
                >
                  <View style={styles.stopButtonInner}>
                    <Feather
                      name="square"
                      size={32}
                      color={theme.COLORS.white}
                    />
                  </View>
                </Pressable>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.resultsContainer}>
            <View style={styles.resultCard}>
              <View style={styles.resultHeader}>
                <Feather
                  name="volume-2"
                  size={20}
                  color={theme.COLORS.subtext}
                />
                <Text style={styles.resultTitle}>Original Audio</Text>
              </View>
              {finalDenoisedWav && !silenceTrim.enabled ? (
                <CompareAudioPlayer key={`${finalOriginalWav.uri}|${finalDenoisedWav.uri}`}
                  originalUri={finalOriginalWav.uri} cleanedUri={finalDenoisedWav.uri} />
              ) : (
                <AudioPlayer uri={finalOriginalWav.uri} name="Original recording" />
              )}
              <View style={styles.resultActions}>
                <SaveButton
                  file={finalOriginalWav}
                  label="Save Original"
                  savedLabel="Saved"
                  albumName="DeepDenoiser Recordings"
                  style={[theme.Styles.button, styles.saveSubButton]}
                  onError={(err) => {
                    setError(err);
                    setIsErrorModalVisible(true);
                  }}
                />
                <ShareBtn uri={finalOriginalWav.uri} />
              </View>
            </View>

            {finalDenoisedWav && (
            <View
              style={[
                styles.resultCard,
                {
                  borderColor: theme.COLORS.success,
                  borderWidth: 1,
                  marginTop: 24,
                },
              ]}
            >
              <View style={styles.resultHeader}>
                <View style={styles.zapIcon}>
                  <Feather
                    name="zap"
                    size={16}
                    color={theme.COLORS.background}
                  />
                </View>
                <Text
                  style={[styles.resultTitle, { color: theme.COLORS.success }]}
                >
                  Denoised Audio
                </Text>
              </View>
              {silenceTrim.enabled ? (
                <AudioPlayer uri={finalDenoisedWav.uri} name="Denoised recording" />
              ) : (
                <Text style={{ color: theme.COLORS.subtext, fontSize: 12 }}>
                  Use the Original / Cleaned switch above to compare at the same position.
                </Text>
              )}
              <View style={styles.resultActions}>
                <SaveButton
                  file={finalDenoisedWav}
                  label="Save Denoised"
                  savedLabel="Saved"
                  albumName="DeepDenoiser Recordings"
                  style={[
                    theme.Styles.button,
                    styles.saveSubButton,
                    { backgroundColor: theme.COLORS.success },
                  ]}
                  savedBg={theme.COLORS.success}
                  onError={(err) => {
                    setError(err);
                    setIsErrorModalVisible(true);
                  }}
                />
                <ShareBtn uri={finalDenoisedWav!.uri} />
              </View>
            </View>
            )}

            <TouchableOpacity
              style={[theme.Styles.button, styles.newRecordButton]}
              onPress={() => {
                setFinalOriginalWav(null);
                setFinalDenoisedWav(null);
              }}
            >
              <Feather
                name="refresh-cw"
                size={18}
                color={theme.COLORS.primary}
              />
              <Text
                style={[
                  theme.Styles.buttonText,
                  { color: theme.COLORS.primary },
                ]}
              >
                Record New
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <ErrorModal
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
    marginBottom: 16,
  },
  presetChip: {
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
    color: theme.COLORS.white,
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
  timerText: {
    fontSize: 72,
    fontWeight: "200",
    color: theme.COLORS.text,
    fontVariant: ["tabular-nums"],
    letterSpacing: -2,
  },
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
  controlsContainer: {
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
  },
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
  activeControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 40,
  },
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
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: theme.COLORS.error,
  },
  stopButtonInner: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: theme.COLORS.error,
    alignItems: "center",
    justifyContent: "center",
  },
  resultsContainer: {
    width: "100%",
    marginTop: 20,
  },
  resultCard: {
    backgroundColor: theme.COLORS.surface,
    borderRadius: 28,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.COLORS.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  resultHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 20,
  },
  resultTitle: {
    fontSize: theme.FONT_SIZE.small,
    fontWeight: "800",
    color: theme.COLORS.subtext,
    textTransform: "uppercase",
    letterSpacing: 1.5,
  },
  resultActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 24,
    gap: 12,
  },
  zapIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.COLORS.success,
    alignItems: "center",
    justifyContent: "center",
  },
  saveSubButton: {
    flex: 1,
    height: 54,
    borderRadius: 18,
    flexDirection: "row",
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  newRecordButton: {
    marginTop: 48,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: theme.COLORS.primary,
    height: 60,
    borderRadius: 20,
    flexDirection: "row",
    gap: 12,
  },
});
