import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import * as theme from "@/src/constants/theme";
import {
  LIVE_BANDS, LIVE_COLUMNS, LIVE_SAMPLE_RATE,
  type LiveModelMonitor, type LiveModelSnapshot, type SpectrumColumn,
} from "@/src/scripts/liveModelMonitor";
import type { BoundedRecordingQueue, RecordingQueueIssue, RecordingQueueSnapshot } from "@/src/scripts/recordingSafety";

const SOUND_COLORS = ["#162838", "#16405A", "#176579", "#219895", "#76D8BE", "#F9E9A8"];
// Teal = lower energy, amber = higher energy. Neither color means “noise”.
const CHANGE_COLORS = ["#148E9A", "#217784", "#285A68", "#203342", "#634F37", "#AB773C", "#F1BA64"];
const EMPTY_QUEUE: RecordingQueueSnapshot = { pendingChunks: 0, pendingSamples: 0, overloaded: false, hasError: false };

type Layer = "input" | "output" | "change";
interface Props {
  monitor: LiveModelMonitor | null;
  queue: BoundedRecordingQueue | null;
  issue: RecordingQueueIssue | null;
  paused: boolean;
  strength: string;
}
const EMPTY_MONITOR: LiveModelSnapshot = { modelFrames: 0, latestIndex: 0, columns: [], visualizationAvailable: false };

/** One native SVG path per palette entry instead of hundreds of native views. */
export function spectrumPaths(columns: SpectrumColumn[], latestIndex: number, layer: Layer): string[] {
  const paletteSize = layer === "change" ? CHANGE_COLORS.length : SOUND_COLORS.length;
  const paths = Array.from({ length: paletteSize }, () => "");
  for (const column of columns) {
    const x = LIVE_COLUMNS - 1 - (latestIndex - column.index);
    if (x < 0 || x >= LIVE_COLUMNS) continue;
    for (let band = 0; band < LIVE_BANDS; band++) {
      const value = column[layer][band];
      if (!Number.isInteger(value)) continue;
      const color = layer === "change" ? value + 3 : value;
      if (color < 0 || color >= paletteSize) continue;
      const y = LIVE_BANDS - 1 - band;
      paths[color] += `M${x} ${y}h1v1h-1z`;
    }
  }
  return paths;
}

function Spectrum({ columns, latestIndex, layer, label }: {
  columns: SpectrumColumn[]; latestIndex: number; layer: Layer; label: string;
}) {
  const paths = useMemo(() => spectrumPaths(columns, latestIndex, layer), [columns, latestIndex, layer]);
  const colors = layer === "change" ? CHANGE_COLORS : SOUND_COLORS;
  return (
    <View style={styles.plotGroup}>
      <Text style={styles.plotLabel}>{label}</Text>
      <View style={styles.plotRow} accessible accessibilityRole="image"
        accessibilityLabel={`${label} frequency display, from 90 hertz to 12 kilohertz. Higher frequencies appear at the top. Latest processed audio is on the right.`}>
        <View style={styles.axis}>
          <Text style={styles.axisText}>12k</Text>
          <Text style={styles.axisText}>90</Text>
        </View>
        <View style={styles.plot}>
          <Svg width="100%" height="100%" viewBox={`0 0 ${LIVE_COLUMNS} ${LIVE_BANDS}`} preserveAspectRatio="none">
            {paths.map((path, index) => path ? <Path key={index} d={path} fill={colors[index]} /> : null)}
          </Svg>
        </View>
      </View>
    </View>
  );
}

export function liveModelStatus(snapshot: LiveModelSnapshot, queue: RecordingQueueSnapshot | null,
  issue: RecordingQueueIssue | null, paused: boolean): string {
  const current = queue ?? EMPTY_QUEUE;
  if (issue === "error" || current.hasError) return "Live cleaning stopped. The app will try to finish after Stop.";
  if (issue === "overloaded" || current.overloaded) return "Live queue is full. The app will try to finish after Stop.";
  if (paused) return current.pendingSamples > 0 ? "Microphone paused; finishing queued audio." : "Microphone paused.";
  if (current.pendingSamples >= LIVE_SAMPLE_RATE / 2) return "Model is behind the microphone.";
  if (!snapshot.modelFrames) return "Waiting for the first model frame.";
  return "Processing live audio.";
}

export default function LiveModelView({ monitor, queue, issue, paused, strength }: Props) {
  const [enabled, setEnabled] = useState(true);
  const enabledRef = useRef(true);
  const foregroundRef = useRef(AppState.currentState !== "background" && AppState.currentState !== "inactive");
  const [snapshot, setSnapshot] = useState<LiveModelSnapshot>(() => monitor?.snapshot() ?? EMPTY_MONITOR);
  const [queueSnapshot, setQueueSnapshot] = useState<RecordingQueueSnapshot>(() => queue?.snapshot() ?? EMPTY_QUEUE);
  // Refresh this small panel, not the entire recorder, five times per second.
  // Suspend analysis while the app is backgrounded; this does not stop recording.
  useEffect(() => {
    monitor?.setEnabled(enabledRef.current && foregroundRef.current);
    const subscription = AppState.addEventListener("change", next => {
      foregroundRef.current = next === "active";
      monitor?.setEnabled(enabledRef.current && foregroundRef.current);
      if (foregroundRef.current) {
        setSnapshot(monitor?.snapshot() ?? EMPTY_MONITOR);
        setQueueSnapshot(queue?.snapshot() ?? EMPTY_QUEUE);
      }
    });
    const timer = setInterval(() => {
      if (!foregroundRef.current) return;
      setSnapshot(monitor?.snapshot() ?? EMPTY_MONITOR);
      setQueueSnapshot(queue?.snapshot() ?? EMPTY_QUEUE);
    }, 200);
    return () => { clearInterval(timer); subscription.remove(); monitor?.setEnabled(false); };
  }, [monitor, queue]);
  const onToggle = () => {
    const next = !enabled;
    enabledRef.current = next;
    monitor?.setEnabled(next && foregroundRef.current);
    setSnapshot(monitor?.snapshot() ?? EMPTY_MONITOR);
    setEnabled(next);
  };
  const queuedMs = Math.round(queueSnapshot.pendingSamples * 1000 / LIVE_SAMPLE_RATE);
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>LIVE MODEL VIEW</Text>
          <Text style={styles.title}>Inside the audio stream</Text>
        </View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={enabled ? "Hide live frequency displays" : "Show live frequency displays"}
          onPress={onToggle} style={styles.toggle}>
          <Text style={styles.toggleText}>{enabled ? "Hide" : "Show"}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.flow}>MIC  →  DEEPFILTERNET  →  STRENGTH MIX</Text>
      <Text style={styles.status} accessibilityLiveRegion="polite">{!monitor && !issue && !queueSnapshot.hasError && !queueSnapshot.overloaded ? "Model metrics unavailable." : liveModelStatus(snapshot, queueSnapshot, issue, paused)}</Text>
      <View style={styles.metrics}>
        <Text style={styles.metric}>Model frames: <Text style={styles.metricValue}>{snapshot.modelFrames}</Text></Text>
        <Text style={styles.metric}>Queue: <Text style={styles.metricValue}>{queuedMs} ms audio</Text></Text>
        <Text style={styles.metric}>Strength: <Text style={styles.metricValue}>{strength}</Text></Text>
      </View>
      {enabled && snapshot.visualizationAvailable ? (
        <>
          <Spectrum columns={snapshot.columns} latestIndex={snapshot.latestIndex} layer="input" label="MIC INPUT" />
          <Spectrum columns={snapshot.columns} latestIndex={snapshot.latestIndex} layer="output" label="CLEANED OUTPUT" />
          <Spectrum columns={snapshot.columns} latestIndex={snapshot.latestIndex} layer="change" label="FREQUENCY CHANGE" />
          {!snapshot.columns.length && <Text style={styles.note}>Waiting for matching input and output samples…</Text>}
          <Text style={styles.note}>Bright = stronger sound. In Change: teal = quieter, amber = louder. Changes can include speech.</Text>
          <Text style={styles.note}>Charts show the latest matched processed audio and may lag the microphone. Blank columns were not measured.</Text>
        </>
      ) : enabled ? (
        <Text style={styles.note}>The frequency display is unavailable. It does not control recording or cleaning; check the status above.</Text>
      ) : (
        <Text style={styles.note}>Frequency displays hidden. Hiding them does not control recording or cleaning.</Text>
      )}
      <Text style={styles.footnote}>Frames include model warm-up. Queue includes in-flight audio, not total device latency. This display is not the model’s internal explanation.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: "100%", backgroundColor: "#172538", borderWidth: 1, borderColor: "#334155", borderRadius: 18, padding: 14, marginBottom: 18 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  headerText: { flex: 1 },
  eyebrow: { color: theme.COLORS.primary, fontSize: 11, fontWeight: "800", letterSpacing: 1.1 },
  title: { color: theme.COLORS.text, fontSize: 16, fontWeight: "700", marginTop: 2 },
  toggle: { minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  toggleText: { color: theme.COLORS.primary, fontSize: 13, fontWeight: "700" },
  flow: { color: "#CBD5E1", fontSize: 10, fontWeight: "700", letterSpacing: 0.4, marginTop: 4 },
  status: { color: theme.COLORS.text, fontSize: 13, fontWeight: "700", marginTop: 9 },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 7, marginBottom: 4 },
  metric: { color: theme.COLORS.subtext, fontSize: 12 },
  metricValue: { color: theme.COLORS.text, fontWeight: "700" },
  plotGroup: { marginTop: 8 },
  plotLabel: { color: "#CBD5E1", fontSize: 10, fontWeight: "800", letterSpacing: 0.7, marginBottom: 4 },
  plotRow: { flexDirection: "row", height: 42, alignItems: "stretch" },
  axis: { width: 25, justifyContent: "space-between", paddingRight: 3 },
  axisText: { color: theme.COLORS.subtext, fontSize: 9, textAlign: "right" },
  plot: { flex: 1, overflow: "hidden", borderRadius: 3, backgroundColor: "#09131F" },
  note: { color: "#CBD5E1", fontSize: 11, lineHeight: 16, marginTop: 6 },
  footnote: { color: theme.COLORS.subtext, fontSize: 10, lineHeight: 15, marginTop: 8 },
});
