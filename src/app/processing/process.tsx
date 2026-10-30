import AdvanceSettings from "@/src/components/advanceSettings";
import AudioPlayer from "@/src/components/audioPlayer";
import CompareAudioPlayer from "@/src/components/CompareAudioPlayer";
import ErrorModal from "@/src/components/ErrorModal";
import SaveButton from "@/src/components/SaveButton";
import ShareBtn from "@/src/components/shareBtn";
import VideoPlayer from "@/src/components/videoPlayer";
import * as theme from "@/src/constants/theme";
import { runSequentialQueue, type CancellationToken, type QueueEvent } from "@/src/scripts/batchQueue";
import { readImportedMediaKind } from "@/src/scripts/denoiseCache";
import { decodeMediaSelection, type SelectedMedia } from "@/src/scripts/mediaSelection";
import { processMedia, type ProcessingProgress, type ProcessingResult, type ProcessingSettings } from "@/src/scripts/processMedia";
import { ATTEN_PRESET_DB, getSettings, incrementDenoiseCount, updateSettings, type AttenPreset } from "@/src/scripts/settings";
import { DEFAULT_SILENCE_TRIM, type SilenceTrimSettings } from "@/src/scripts/silenceTrim";
import Feather from "@expo/vector-icons/Feather";
import { Host, LoadingIndicator } from "@expo/ui/jetpack-compose";
import * as fs from "expo-file-system";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import React, { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

type ItemStatus = "waiting" | "working" | "done" | "failed" | "cancelled";
interface QueueItem extends SelectedMedia {
  status: ItemStatus;
  outputUri?: string;
  seconds?: number;
  cached?: boolean;
  trimEnabled?: boolean;
  error?: string;
  errorDetail?: Error;
}

function decode(value: string | undefined): string {
  try { return decodeURIComponent(value || ""); } catch { return value || ""; }
}
function initialQueue(batch: string | undefined, uri: string | undefined, name: string | undefined): QueueItem[] {
  // A malformed batch must not silently degrade to processing just its first file.
  if (batch) return decodeMediaSelection(batch).map(file => ({ ...file, status: "waiting" }));
  const fileUri = decode(uri);
  const filename = decode(name);
  if (!fileUri.startsWith("file:")) return [];
  try {
    const kind = readImportedMediaKind(new fs.File(fileUri));
    return kind ? [{ uri: fileUri, name: filename || "shared_file", kind, status: "waiting" }] : [];
  } catch { return []; }
}
function duration(seconds: number): string {
  const n = Math.max(0, Math.round(seconds));
  return n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`;
}
function presetFor(value: number): AttenPreset {
  const found = (Object.entries(ATTEN_PRESET_DB) as [Exclude<AttenPreset, "custom">, number][])
    .find(([, db]) => db === value);
  return found ? found[0] : "custom";
}

export default function ProcessScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ fileuri?: string; filename?: string; batch?: string }>();
  const [items, setItems] = useState<QueueItem[]>(() => initialQueue(params.batch, params.fileuri, params.filename));
  const [selected, setSelected] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<ProcessingProgress>({ stage: "", percent: 0, eta: null });
  const [attenLimDb, setAttenLimDb] = useState(0);
  const [settingsReady, setSettingsReady] = useState(false);
  const [silenceTrim, setSilenceTrim] = useState<SilenceTrimSettings>({ ...DEFAULT_SILENCE_TRIM });
  const [normalize, setNormalize] = useState({ toggle: false, targetRMS: -14, maxPeakDb: -1 });
  const [error, setError] = useState<Error | null>(null);
  const [showError, setShowError] = useState(false);
  const tokenRef = useRef<CancellationToken | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    void getSettings().then((s) => { if (active) setAttenLimDb(s.attenLimDb); })
      .catch((err) => {
        if (active) { setError(new Error(`Could not load saved settings; using the default strength. ${err instanceof Error ? err.message : String(err)}`)); setShowError(true); }
      }).finally(() => { if (active) setSettingsReady(true); });
    return () => {
      active = false;
      mountedRef.current = false;
      if (tokenRef.current) tokenRef.current.cancelled = true;
    };
  }, []);

  const changeStrength = (value: number) => {
    setAttenLimDb(value);
    void updateSettings({ attenLimDb: value, attenPreset: presetFor(value) }).catch((err) => {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err))); setShowError(true);
    });
  };

  const run = async () => {
    if (runningRef.current || !items.length || !settingsReady) return;
    runningRef.current = true;
    const notDone = items.map((item, index) => ({ item, index })).filter(({ item }) => item.status !== "done");
    const batch = notDone.length ? notDone : items.map((item, index) => ({ item, index }));
    const selectedIndices = new Set(batch.map(({ index }) => index));
    const token: CancellationToken = { cancelled: false };
    tokenRef.current = token;
    const settings: ProcessingSettings = { attenLimDb, normalize: { ...normalize }, silenceTrim: { ...silenceTrim } };
    setIsProcessing(true); setStopping(false);
    setItems((current) => current.map((item, index) => selectedIndices.has(index)
      ? { ...item, status: "waiting", outputUri: undefined, error: undefined, errorDetail: undefined } : item));
    try {
      await runSequentialQueue(batch, token, async ({ item }, _index, currentToken) => {
        const file = new fs.File(item.uri);
        if (!file.exists) throw new Error("The imported file is no longer available. Please import it again.");
        return processMedia(file, item.name, item.kind === "video", settings, currentToken, (value) => {
          if (mountedRef.current) setProgress(value);
        });
      }, (event: QueueEvent<ProcessingResult>) => {
        const index = batch[event.index].index;
        if (event.type === "completed") {
          void incrementDenoiseCount().catch((err) => console.warn("Could not update processing count:", err));
        }
        if (!mountedRef.current) return;
        if (event.type === "started") {
          setSelected(index);
          setProgress({ stage: "Preparing…", percent: 0, eta: null });
        }
        setItems((current) => current.map((item, i) => {
          if (i !== index) return item;
          if (event.type === "started") return { ...item, status: "working", error: undefined, errorDetail: undefined };
          if (event.type === "completed") return { ...item, status: "done", outputUri: event.result.file.uri,
            seconds: event.result.seconds, cached: event.result.cached, trimEnabled: event.result.trimEnabled };
          if (event.type === "cancelled") return { ...item, status: "cancelled" };
          return { ...item, status: "failed", error: event.error.message, errorDetail: event.error };
        }));
      });
    } catch (err) {
      if (mountedRef.current) { setError(err instanceof Error ? err : new Error(String(err))); setShowError(true); }
    } finally {
      tokenRef.current = null;
      runningRef.current = false;
      if (mountedRef.current) { setIsProcessing(false); setStopping(false); }
    }
  };

  const stop = () => {
    if (!tokenRef.current || stopping) return;
    tokenRef.current.cancelled = true;
    setStopping(true);
  };

  usePreventRemove(isProcessing, () => {
    if (stopping) {
      Alert.alert("Stopping processing", "Please wait until the current operation has finished safely.");
      return;
    }
    Alert.alert("Processing in progress", "Stop processing before leaving? Finished results are kept.", [
      { text: "Keep processing", style: "cancel" },
      { text: "Stop processing", onPress: stop },
    ]);
  });

  const current = items[selected] ?? items[0];
  const doneCount = items.filter((item) => item.status === "done").length;
  const pendingCount = items.filter((item) => item.status !== "done").length;
  const hasVideo = items.some((item) => item.kind === "video");
  const output = current?.outputUri ? new fs.File(current.outputUri) : null;

  if (!current) {
    return <SafeAreaView style={[theme.Styles.container, styles.empty]}><Feather name="file" size={36} color={theme.COLORS.subtext} />
      <Text style={styles.heading}>No valid media selected</Text><Text style={styles.helper}>For an older import, choose its audio or video type in Your files first.</Text><TouchableOpacity style={theme.Styles.button} onPress={() => router.replace("/")}><Text style={theme.Styles.buttonText}>Choose files</Text></TouchableOpacity></SafeAreaView>;
  }

  return (
    <SafeAreaView style={theme.Styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} disabled={isProcessing} style={styles.back}><Feather name="arrow-left" size={22} color={theme.COLORS.text} /></TouchableOpacity>
        <View style={{ flex: 1 }}><Text style={styles.heading}>{items.length > 1 ? "Batch denoise" : "Denoise media"}</Text><Text style={styles.subheading}>Private, on-device processing</Text></View>
        <View style={styles.headerBadge}><Text style={styles.headerBadgeText}>{doneCount}/{items.length} DONE</Text></View>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 165 }} showsVerticalScrollIndicator={false}>
        {items.length > 1 && <View style={styles.card}>
          <View style={styles.cardHeader}><Text style={styles.cardTitle}>QUEUE</Text><Text style={styles.muted}>Tap a file to view it</Text></View>
          {items.map((item, index) => (
            <TouchableOpacity key={`${item.uri}-${index}`} accessibilityRole="button" accessibilityState={{ selected: selected === index }}
              accessibilityLabel={`${item.name}, ${item.status}`} onPress={() => setSelected(index)} style={[styles.queueRow, selected === index && styles.queueRowActive]}>
              <View style={[styles.statusDot, item.status === "done" && styles.statusDone, item.status === "failed" && styles.statusFailed, item.status === "working" && styles.statusWorking]} />
              <View style={{ flex: 1 }}><Text numberOfLines={1} style={styles.queueName}>{item.name}</Text><Text style={styles.queueStatus}>{item.status === "working" ? "Processing" : item.status === "done" ? "Ready" : item.status === "failed" ? "Failed — tap for details" : item.status === "cancelled" ? "Stopped" : "Waiting"}</Text></View>
              <Feather name={item.status === "done" ? "check-circle" : item.kind === "video" ? "film" : "music"} size={17} color={item.status === "done" ? theme.COLORS.success : theme.COLORS.subtext} />
            </TouchableOpacity>
          ))}
        </View>}

        {output && <View style={styles.result}>
          <View style={styles.cardHeader}>
            <Text style={styles.resultTitle}>Cleaned file</Text>
            <Text style={styles.muted}>{current.cached ? "Cached result" : `Processed in ${duration(current.seconds ?? 0)}`}</Text>
          </View>
          <Text numberOfLines={1} style={styles.originalName}>{current.name}</Text>
          {current.kind === "video" ? <VideoPlayer key={output.uri} uri={output.uri} name={output.name} />
            : current.trimEnabled ? <><Text style={styles.helper}>Silence trimming changes the timeline, so synchronized comparison is unavailable.</Text><AudioPlayer key={output.uri} uri={output.uri} name={output.name} /></>
              : <CompareAudioPlayer key={`${current.uri}|${output.uri}`} originalUri={current.uri} cleanedUri={output.uri} />}
          <View style={styles.resultActions}><SaveButton key={output.uri} file={output} label="Save to device" style={styles.saveButton} onError={(err) => { setError(err); setShowError(true); }} />
            <View style={styles.shareButton}><ShareBtn uri={output.uri} accessibilityLabel="Share cleaned file" /></View></View>
        </View>}

        {current.status === "failed" && <View>
          <View style={styles.errorCard}><Feather name="alert-circle" size={19} color={theme.COLORS.error} /><Text style={styles.errorText}>{current.error || "Processing failed."}</Text></View>
          <TouchableOpacity accessibilityRole="button" onPress={() => { setError(current.errorDetail ?? new Error(current.error || "Processing failed.")); setShowError(true); }} style={styles.errorDetailsButton}>
            <Text style={styles.errorDetailsText}>View and copy error details</Text>
          </TouchableOpacity>
        </View>}
        {current.status === "cancelled" && <Text style={styles.helper}>Stopped safely. You can retry this file.</Text>}

        {(!output || current.kind === "video" || current.trimEnabled) && <View style={styles.card}>
          <View style={styles.cardHeader}><Text style={styles.cardTitle}>ORIGINAL FILE</Text><Text style={styles.muted}>{current.kind.toUpperCase()}</Text></View>
          {current.kind === "video" ? <VideoPlayer key={current.uri} uri={current.uri} name={current.name} />
            : <AudioPlayer key={current.uri} uri={current.uri} name={current.name} />}
        </View>}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{output ? "OUTPUT DETAILS" : "BEFORE YOU PROCESS"}</Text>
          <Text style={styles.helper}>Output audio is 48 kHz mono. Keep the original file.</Text>
          {hasVideo && <Text style={styles.helper}>Video output contains one video track and the cleaned audio. Subtitles, extra tracks and some metadata may be omitted; unsupported video may be re-encoded at 30 fps.</Text>}
        </View>
        {!settingsReady && <Text accessibilityLiveRegion="polite" style={styles.helper}>Loading saved settings…</Text>}
        <View pointerEvents={isProcessing || !settingsReady ? "none" : "auto"}
          importantForAccessibility={isProcessing || !settingsReady ? "no-hide-descendants" : "auto"}
          style={isProcessing || !settingsReady ? styles.disabled : undefined}>
          <AdvanceSettings attenLimDb={attenLimDb} onAttenLimDbChange={changeStrength} normalize={normalize}
            onNormalizeChange={setNormalize} silenceTrim={silenceTrim} onSilenceTrimChange={setSilenceTrim} showSilenceTrim={!hasVideo} />
          {hasVideo && items.length > 1 && <Text style={styles.helper}>Silence trim is unavailable for mixed/video batches to keep video in sync.</Text>}
        </View>

        {isProcessing && <View style={[styles.card, styles.progressCard]}>
          <View style={styles.progressTop}><View style={{ flex: 1 }}><Text style={styles.progressLabel}>{stopping ? "Stopping after the current step…" : progress.stage}</Text>
            <Text style={styles.muted}>{doneCount} of {items.length} completed{progress.eta ? ` · ${progress.eta}` : ""}</Text></View><Text style={styles.progressNumber}>{progress.percent}%</Text></View>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.min(100, Math.max(0, progress.percent))}%` }]} /></View>
          {stopping && <Text style={styles.helper}>An Android decode or export already in progress may need to finish first.</Text>}
        </View>}

      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(12, insets.bottom) }]}>
        {isProcessing ? <TouchableOpacity style={styles.stopButton} onPress={stop} disabled={stopping}>
          {stopping ? <Host matchContents colorScheme="dark"><LoadingIndicator color={theme.COLORS.text} /></Host> : <Feather name="square" size={17} color={theme.COLORS.text} />}
          <Text style={styles.stopText}>{stopping ? "Stopping…" : "Stop processing"}</Text></TouchableOpacity>
          : <View style={styles.footerRow}>
            {doneCount > 0 && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Choose new media" onPress={() => router.replace("/")} style={styles.newButton}><Feather name="plus" size={19} color={theme.COLORS.primary} /></TouchableOpacity>}
            <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: !settingsReady }} disabled={!settingsReady}
              style={[theme.Styles.button, { flex: 1 }, pendingCount === 0 && styles.rerunButton, !settingsReady && styles.disabled]} onPress={() => void run()}><Feather name="zap" size={18} color={pendingCount === 0 ? theme.COLORS.primary : theme.COLORS.background} style={{ marginRight: 8 }} /><Text style={[theme.Styles.buttonText, pendingCount === 0 && styles.rerunText]}>{!settingsReady ? "Loading settings…" : pendingCount === 0 ? "Process again" : items.length === 1 ? "Start denoising" : `Process ${pendingCount} file${pendingCount === 1 ? "" : "s"}`}</Text></TouchableOpacity>
          </View>}
      </View>
      <ErrorModal context="process" visible={showError} error={error} onClose={() => setShowError(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  empty: { justifyContent: "center", alignItems: "center", gap: 18 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16, marginBottom: 22 },
  back: { width: 42, height: 42, borderRadius: 13, backgroundColor: theme.COLORS.surface, justifyContent: "center", alignItems: "center" },
  heading: { color: theme.COLORS.text, fontSize: 20, fontWeight: "800" }, subheading: { color: theme.COLORS.subtext, fontSize: 12, marginTop: 3 },
  headerBadge: { backgroundColor: "rgba(0,229,255,0.08)", paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10 }, headerBadgeText: { color: theme.COLORS.primary, fontWeight: "800", fontSize: 10 },
  card: { backgroundColor: theme.COLORS.surface, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: theme.COLORS.border, marginBottom: 14 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }, cardTitle: { color: theme.COLORS.subtext, fontSize: 11, fontWeight: "800", letterSpacing: 1 }, muted: { color: theme.COLORS.subtext, fontSize: 11 },
  originalName: { color: theme.COLORS.subtext, fontSize: 13, marginBottom: 14 },
  queueRow: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, padding: 10 }, queueRowActive: { backgroundColor: "rgba(0,229,255,0.08)" },
  queueName: { color: theme.COLORS.text, fontSize: 13, fontWeight: "700" }, queueStatus: { color: theme.COLORS.subtext, fontSize: 11, marginTop: 3 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.COLORS.border }, statusDone: { backgroundColor: theme.COLORS.success }, statusFailed: { backgroundColor: theme.COLORS.error }, statusWorking: { backgroundColor: theme.COLORS.primary },
  disabled: { opacity: 0.6 }, helper: { color: theme.COLORS.subtext, fontSize: 12, lineHeight: 18, marginVertical: 8 },
  progressCard: { marginTop: 14 }, progressTop: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 13 }, progressLabel: { color: theme.COLORS.text, fontWeight: "700", fontSize: 14, marginBottom: 4 }, progressNumber: { color: theme.COLORS.primary, fontWeight: "800", fontSize: 18 },
  progressTrack: { height: 7, borderRadius: 5, backgroundColor: theme.COLORS.border, overflow: "hidden" }, progressFill: { height: "100%", backgroundColor: theme.COLORS.primary },
  errorCard: { flexDirection: "row", gap: 10, padding: 15, backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 16, marginTop: 14 }, errorText: { flex: 1, color: theme.COLORS.text, fontSize: 13 },
  errorDetailsButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12 }, errorDetailsText: { color: theme.COLORS.primary, fontSize: 13, fontWeight: "700" },
  result: { backgroundColor: theme.COLORS.surface, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: theme.COLORS.border, marginBottom: 14 },
  resultTitle: { color: theme.COLORS.text, fontSize: 17, fontWeight: "800" },
  resultActions: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 18 }, saveButton: { flex: 1, backgroundColor: theme.COLORS.primary, height: 48, borderRadius: 13 }, shareButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: theme.COLORS.background },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 12, backgroundColor: theme.COLORS.background }, footerRow: { flexDirection: "row", gap: 10 },
  newButton: { width: 54, height: 56, borderRadius: 15, borderWidth: 1, borderColor: theme.COLORS.primary, alignItems: "center", justifyContent: "center" },
  rerunButton: { backgroundColor: "transparent", borderWidth: 1, borderColor: theme.COLORS.primary }, rerunText: { color: theme.COLORS.primary },
  stopButton: { height: 56, borderRadius: 16, borderWidth: 1, borderColor: theme.COLORS.error, flexDirection: "row", gap: 10, justifyContent: "center", alignItems: "center" }, stopText: { color: theme.COLORS.text, fontWeight: "800", fontSize: 15 },
});
