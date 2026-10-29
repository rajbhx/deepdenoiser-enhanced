import { getDiagnosticsInfo, type DiagnosticsInfo } from "@/modules/AudioProcessorModule";
import * as theme from "@/src/constants/theme";
import { AudioStudioModule } from "@siteed/audio-studio";
import Feather from "@expo/vector-icons/Feather";
import { requireNativeModule } from "expo";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Linking, Modal, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getEngineLabel } from "@/src/scripts/denoiserSingleton";
import { useProcessingBusy } from "@/src/scripts/useProcessingBusy";
import { clearDiagnosticHistory, getDiagnosticSnapshot, initializeDiagnostics, setDiagnosticPersistence, subscribeDiagnostics } from "@/src/scripts/diagnostics";
import { EVENT_LABELS } from "@/src/scripts/diagnosticsCore";
import { buildDiagnosticReport, type RecorderState, type ShareState } from "@/src/scripts/diagnosticReport";
import { benchmarkDiagnosticProvider, runDiagnosticSelfCheck, type DiagnosticRunResult } from "@/src/scripts/diagnosticSelfCheck";
import { getSettings, resolveCoreLevel, type AppSettings } from "@/src/scripts/settings";

const bytes = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${(value / 1073741824).toFixed(1)} GiB` : "Unknown";
const yesNo = (value: boolean | undefined) => value === undefined ? "Unknown" : value ? "Yes" : "No";
const thermal = (value: number | null | undefined) => value == null ? "Unavailable" : (["None", "Light", "Moderate", "Severe", "Critical", "Emergency", "Shutdown"][value] ?? "Unknown");

function recorderStatus(): RecorderState {
  try {
    const status = AudioStudioModule.status() as { isRecording?: boolean; isPaused?: boolean; isWriterActive?: boolean };
    if (typeof status.isWriterActive !== "boolean" || typeof status.isRecording !== "boolean" || typeof status.isPaused !== "boolean") return "unknown";
    if (status.isPaused) return "paused";
    if (status.isRecording || status.isWriterActive) return "active";
    return "idle";
  } catch { return "unknown"; }
}
function shareStatus(): ShareState {
  try {
    const sharing = requireNativeModule<{ getShareIntentGeneration(): string }>("ExpoSharing");
    return sharing.getShareIntentGeneration() ? "pending" : "none";
  } catch { return "unknown"; }
}

function Row({ label, value }: { label: string; value: string }) {
  return <View style={styles.row}><Text style={styles.rowLabel}>{label}</Text><Text style={styles.rowValue}>{value}</Text></View>;
}
function Action({ title, onPress, disabled = false, secondary = false }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.action, secondary && styles.actionSecondary, disabled && styles.disabled]}>
    <Text style={[styles.actionText, secondary && styles.actionSecondaryText]}>{title}</Text>
  </TouchableOpacity>;
}

export default function DiagnosticsScreen() {
  const router = useRouter();
  const alive = useRef(true);
  const runningRef = useRef(false);
  const snapshot = useSyncExternalStore(subscribeDiagnostics, getDiagnosticSnapshot, getDiagnosticSnapshot);
  const busy = useProcessingBusy();
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [engine, setEngine] = useState("not-loaded");
  const [recorder, setRecorder] = useState<RecorderState>("unknown");
  const [share, setShare] = useState<ShareState>("unknown");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [savingHistory, setSavingHistory] = useState(false);
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const [selfCheck, setSelfCheck] = useState<DiagnosticRunResult | null>(null);
  const [benchmarks, setBenchmarks] = useState<Partial<Record<"cpu" | "xnnpack" | "nnapi", DiagnosticRunResult>>>({});
  const [includeDevice, setIncludeDevice] = useState(false);
  const [showReport, setShowReport] = useState(false);

  const refresh = useCallback(async () => {
    if (alive.current) setLoading(true);
    const [deviceResult, settingsResult] = await Promise.allSettled([getDiagnosticsInfo(), getSettings()]);
    if (!alive.current) return;
    setInfo(deviceResult.status === "fulfilled" ? deviceResult.value : null);
    setSettings(settingsResult.status === "fulfilled" ? settingsResult.value : null);
    setEngine(getEngineLabel());
    setRecorder(recorderStatus());
    setShare(shareStatus());
    setLoading(false);
  }, []);
  useEffect(() => {
    alive.current = true;
    void initializeDiagnostics();
    void refresh();
    return () => { alive.current = false; };
  }, [refresh]);
  usePreventRemove(running, () => Alert.alert("Self-check is running", "Wait for the current test to finish. Your recordings and files are not used by this test."));

  const run = async (mode?: "cpu" | "xnnpack" | "nnapi") => {
    if (runningRef.current || busy) return;
    runningRef.current = true; setRunning(true);
    try {
      const result = mode ? await benchmarkDiagnosticProvider(mode) : await runDiagnosticSelfCheck();
      if (!alive.current) return;
      if (mode) setBenchmarks(current => ({ ...current, [mode]: result })); else setSelfCheck(result);
    } catch (error) {
      if (alive.current) Alert.alert("Cannot run diagnostics", error instanceof Error ? error.message : "The self-check could not run.");
    } finally {
      runningRef.current = false;
      if (alive.current) { setRunning(false); void refresh(); }
    }
  };
  const changePersistence = () => {
    const enabling = !snapshot.persistent;
    Alert.alert(enabling ? "Save diagnostic history?" : "Turn off saved history?", enabling
      ? "Up to 50 structured events will be kept on this device in app-specific no-backup storage. No media, filenames, paths or raw errors are stored. Nothing is uploaded. Events can still be lost after a sudden crash."
      : "Saved diagnostic events will be deleted. Current-session events remain in memory until cleared or the app closes.", [
      { text: "Cancel", style: "cancel" },
      { text: enabling ? "Enable" : "Turn off & delete", onPress: () => {
        setSavingHistory(true);
        void setDiagnosticPersistence(enabling).catch(error => Alert.alert("Diagnostic history", error.message)).finally(() => { if (alive.current) setSavingHistory(false); });
      } },
    ]);
  };
  const clearHistory = () => Alert.alert("Clear diagnostic events?", "This removes only diagnostic history. It does not delete recordings, media or caches.", [
    { text: "Cancel", style: "cancel" },
    { text: "Clear", style: "destructive", onPress: () => {
      setSavingHistory(true);
      void clearDiagnosticHistory().catch(error => Alert.alert("Diagnostic history", error.message)).finally(() => { if (alive.current) setSavingHistory(false); });
    } },
  ]);
  const openIssue = () => Alert.alert("Open GitHub?", "GitHub issues are public. Do not post private filenames, paths, recordings or personal information.", [
    { text: "Cancel", style: "cancel" },
    { text: "Open GitHub", onPress: () => { void Linking.openURL("https://github.com/rajbhx/deepdenoiser-enhanced/issues/new"); } },
  ]);

  const buildCommit = typeof Constants.expoConfig?.extra?.diagnosticBuildCommit === "string" ? Constants.expoConfig.extra.diagnosticBuildCommit : "unknown";
  const report = buildDiagnosticReport({ info, buildCommit, settings, engine, recorder, busy, share, events: snapshot.events, selfCheck, benchmarks, includeDevice });
  const shownEvents = [...snapshot.events].reverse().filter(event => filter === "all" || event.level === "error" || event.level === "warning");
  const hasTestResult = !!selfCheck || Object.keys(benchmarks).length > 0;

  return <SafeAreaView style={styles.container}>
    <View style={styles.header}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={styles.back}><Feather name="arrow-left" size={23} color={theme.COLORS.text} /></TouchableOpacity>
      <View style={{ flex: 1 }}><Text style={styles.title}>Diagnostics</Text><Text style={styles.subtitle}>Private by default · no automatic uploads</Text></View>
    </View>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.heading}>App & device</Text>
        <Row label="Version" value={info ? `${info.versionName} (${info.versionCode})` : "Unavailable"} />
        <Row label="Build commit" value={buildCommit === "unknown" ? "Unavailable" : buildCommit.slice(0, 12)} />
        <Row label="Build mode" value={info ? (info.debuggable ? "Debuggable" : "Not debuggable") : "Unknown"} />
        <Row label="Signing hint" value={info?.androidDebugSubject === true ? "Android Debug certificate · testing only" : info?.androidDebugSubject === false ? "Other certificate · not release approval" : "Unknown"} />
        <Row label="Phone" value={info ? `${info.manufacturer} ${info.model}` : "Unavailable"} />
        <Row label="Android" value={info ? `${info.androidVersion} (API ${info.sdk})` : "Unavailable"} />
        <Row label="App storage available" value={bytes(info?.freeStorageBytes)} />
        <Row label="Available / total RAM" value={info ? `${bytes(info.availableMemoryBytes)} / ${bytes(info.totalMemoryBytes)}` : "Unavailable"} />
        <Row label="App memory (approx.)" value={bytes(info?.processPssBytes)} />
        <Row label="Battery / thermal" value={`${info?.batteryPercent == null ? "Unavailable" : `${info.batteryPercent}%`} / ${thermal(info?.thermalStatus)}`} />
        <Text style={styles.note}>Memory and storage are estimates for this device and app volume. A provider or export destination can behave differently.</Text>
        <Action title={loading ? "Refreshing…" : "Refresh status"} onPress={() => { void refresh(); }} disabled={loading} secondary />
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Model & activity</Text>
        <Row label="Selected runtime" value={settings?.runtime ?? "Unknown"} />
        <Row label="Attempted provider" value={engine} />
        <Row label="Configured threads" value={settings ? String(resolveCoreLevel(settings)) : "Unknown"} />
        <Row label="Recorder writer" value={recorder} />
        <Row label="Processing guard" value={busy ? "Busy" : "Idle"} />
        <Row label="Incoming share" value={share} />
        <Text style={styles.note}>A provider label does not prove which hardware ran the model. “Idle” does not certify background recording reliability.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Permissions & previous exit</Text>
        <Row label="Microphone" value={yesNo(info?.microphoneGranted)} />
        <Row label="Notifications enabled" value={yesNo(info?.notificationsEnabled)} />
        <Row label="Media-read grants" value={info ? `Audio: ${yesNo(info.mediaAudioGranted)} · Video: ${yesNo(info.mediaVideoGranted)}` : "Unknown"} />
        <Text style={styles.note}>The Android file picker may work without broad media-read grants. A notification setting does not prove the recording service is running.</Text>
        <Row label="Last process exit" value={info?.previousExit?.reason ?? "Unavailable"} />
        <Text style={styles.note}>Where Android provides it, this is a prior exit reason—not proof of a crash. Force-stops, updates and system kills can also end a process.</Text>
        <Action title="Open Android app settings" onPress={() => { void Linking.openSettings(); }} secondary />
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Safe self-check</Text>
        <Text style={styles.note}>Uses a generated tone and unique app-created temporary files. No microphone or user media is opened. Runs only while recording and processing are idle; a long test can use battery.</Text>
        <Action title={running ? "Testing…" : "Run self-check"} onPress={() => { void run(); }} disabled={running || busy || recorder !== "idle"} />
        {selfCheck?.checks.map((check, index) => <View key={`${check.id}-${index}`} style={styles.check}>
          <Text style={styles.checkTitle}>{check.status === "passed" ? "✓" : check.status === "warning" ? "!" : "×"} {check.label}</Text>
          <Text style={styles.note}>{check.detail}{check.elapsedMs === undefined ? "" : ` (${check.elapsedMs} ms)`}</Text>
        </View>)}
        {selfCheck?.attemptedEngine && <Text style={styles.note}>Attempted provider: {selfCheck.attemptedEngine}; short-test speed: {selfCheck.realtimeFactor?.toFixed(2)}× real time. This does not certify listening quality.</Text>}
        <Text style={[styles.heading, { marginTop: 18 }]}>Optional runtime comparison</Text>
        <Text style={styles.note}>Run one at a time. The current model is released and reloaded later; saved settings are not changed. Fallbacks may occur and short timings are only indicative.</Text>
        <View style={styles.buttonRow}>{(["cpu", "xnnpack", "nnapi"] as const).map(mode => <TouchableOpacity key={mode} accessibilityRole="button" accessibilityState={{ disabled: running || busy || recorder !== "idle" }}
          disabled={running || busy || recorder !== "idle"} style={[styles.chip, (running || busy || recorder !== "idle") && styles.disabled]} onPress={() => { void run(mode); }}>
          <Text style={styles.chipText}>{mode.toUpperCase()}</Text>
        </TouchableOpacity>)}</View>
        {(["cpu", "xnnpack", "nnapi"] as const).map(mode => benchmarks[mode] && <Text key={mode} style={styles.note}>
          {mode.toUpperCase()}: {benchmarks[mode]?.checks[0]?.status}; attempted {benchmarks[mode]?.attemptedEngine ?? "unknown"}; {benchmarks[mode]?.realtimeFactor?.toFixed(2) ?? "unknown"}× (indicative only).
        </Text>)}
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Recent events ({snapshot.events.length}/50)</Text>
        <Text style={styles.note}>Only fixed categories and timings are kept. Raw error text, filenames, paths, media and user-media hashes are not recorded here. Events are in memory unless you opt in to saved history.</Text>
        {snapshot.storageError && <Text accessibilityRole="alert" style={styles.warning}>{snapshot.storageError}</Text>}
        <View style={styles.buttonRow}>
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: filter === "all" }} onPress={() => setFilter("all")} style={[styles.chip, filter === "all" && styles.chipSelected]}><Text style={styles.chipText}>All</Text></TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: filter === "errors" }} onPress={() => setFilter("errors")} style={[styles.chip, filter === "errors" && styles.chipSelected]}><Text style={styles.chipText}>Errors & warnings</Text></TouchableOpacity>
        </View>
        {!shownEvents.length && <Text style={styles.note}>No events in this view.</Text>}
        {shownEvents.map((event, index) => <View key={`${event.time}-${index}`} style={styles.event}>
          <Text style={styles.eventTitle}>{EVENT_LABELS[event.code].label} · {event.domain} / {event.stage}</Text>
          <Text style={styles.note}>{new Date(event.time).toLocaleString()} · {event.code}{event.elapsedMs === undefined ? "" : ` · ${event.elapsedMs} ms`}</Text>
          {!!EVENT_LABELS[event.code].advice && <Text style={styles.note}>{EVENT_LABELS[event.code].advice}</Text>}
        </View>)}
        <Action title={snapshot.persistent ? "Turn off saved history" : "Enable saved history"} onPress={changePersistence} disabled={!snapshot.ready || savingHistory} secondary />
        <Action title="Clear diagnostic history" onPress={clearHistory} disabled={!snapshot.ready || savingHistory} secondary />
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Share a report</Text>
        <Text style={styles.note}>Review a structured report before copying or sharing. It contains no raw exceptions or media details by design. Android logs shared separately may contain private information.</Text>
        <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: includeDevice }} onPress={() => setIncludeDevice(!includeDevice)} style={styles.checkbox}>
          <Feather name={includeDevice ? "check-square" : "square"} size={20} color={theme.COLORS.primary} />
          <Text style={styles.rowLabel}>Include phone, Android, memory and permission details</Text>
        </TouchableOpacity>
        <Action title="Preview report" onPress={() => setShowReport(true)} />
        <Action title="Open a GitHub issue" onPress={openIssue} secondary />
        {!hasTestResult && <Text style={styles.note}>Self-check results will appear in the report after you run them.</Text>}
      </View>
      <Text style={styles.footer}>Diagnostics are not a production-release, privacy, licensing or real-device certification.</Text>
    </ScrollView>
    <Modal transparent animationType="slide" visible={showReport} onRequestClose={() => setShowReport(false)}>
      <View style={styles.modalOverlay}><View style={styles.modal}>
        <Text style={styles.heading}>Review report</Text>
        <Text style={styles.note}>Share only if you are comfortable with every detail below.</Text>
        <ScrollView style={styles.report}><Text selectable style={styles.reportText}>{report}</Text></ScrollView>
        <Action title="Copy report" onPress={() => { void Clipboard.setStringAsync(report).then(() => Alert.alert("Copied", "Review the report before sharing it.")); }} />
        <Action title="Share report…" onPress={() => { void Share.share({ message: report }); }} secondary />
        <Action title="Close" onPress={() => setShowReport(false)} secondary />
      </View></View>
    </Modal>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.COLORS.background }, header: { paddingHorizontal: 18, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 14 },
  back: { minWidth: 44, minHeight: 44, justifyContent: "center" }, title: { color: theme.COLORS.text, fontSize: 24, fontWeight: "800" }, subtitle: { color: theme.COLORS.subtext, fontSize: 12, marginTop: 3 },
  content: { paddingHorizontal: 16, paddingBottom: 36, gap: 14 }, card: { backgroundColor: theme.COLORS.surface, borderRadius: 18, padding: 17, borderWidth: 1, borderColor: theme.COLORS.border },
  heading: { color: theme.COLORS.text, fontSize: 16, fontWeight: "800", marginBottom: 10 }, row: { flexDirection: "row", justifyContent: "space-between", gap: 14, paddingVertical: 5 },
  rowLabel: { color: theme.COLORS.subtext, fontSize: 13, flex: 1 }, rowValue: { color: theme.COLORS.text, fontSize: 13, flex: 1.4, textAlign: "right" },
  note: { color: theme.COLORS.subtext, fontSize: 12, lineHeight: 18, marginTop: 8 }, warning: { color: theme.COLORS.error, fontSize: 13, marginTop: 8 },
  action: { minHeight: 46, borderRadius: 11, backgroundColor: theme.COLORS.primary, alignItems: "center", justifyContent: "center", marginTop: 10, paddingHorizontal: 10 },
  actionSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: theme.COLORS.border }, actionText: { color: theme.COLORS.background, fontWeight: "800", fontSize: 13 },
  actionSecondaryText: { color: theme.COLORS.primary }, disabled: { opacity: 0.45 }, buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  chip: { minHeight: 42, borderRadius: 9, borderWidth: 1, borderColor: theme.COLORS.border, justifyContent: "center", paddingHorizontal: 12 }, chipSelected: { borderColor: theme.COLORS.primary }, chipText: { color: theme.COLORS.text, fontWeight: "700", fontSize: 12 },
  check: { marginTop: 12 }, checkTitle: { color: theme.COLORS.text, fontSize: 13, fontWeight: "700" }, event: { borderTopWidth: 1, borderColor: theme.COLORS.border, paddingVertical: 10 }, eventTitle: { color: theme.COLORS.text, fontSize: 13, fontWeight: "700" },
  checkbox: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 }, footer: { color: theme.COLORS.subtext, fontSize: 12, lineHeight: 19, textAlign: "center" },
  modalOverlay: { flex: 1, backgroundColor: "#000000bb", justifyContent: "center", padding: 18 }, modal: { maxHeight: "90%", backgroundColor: theme.COLORS.surface, borderRadius: 18, padding: 18 },
  report: { maxHeight: 420, marginTop: 12, backgroundColor: "#00000033", borderRadius: 10, padding: 10 }, reportText: { color: theme.COLORS.text, fontSize: 12, lineHeight: 18 },
});
