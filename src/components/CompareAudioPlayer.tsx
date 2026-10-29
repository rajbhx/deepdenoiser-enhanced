import * as theme from "@/src/constants/theme";
import { switchPlayback, togglePlayback } from "@/src/scripts/comparePlayback";
import Feather from "@expo/vector-icons/Feather";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useFocusEffect } from "expo-router/react-navigation";
import React, { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

interface Props { originalUri: string; cleanedUri: string }
type Track = "original" | "cleaned";
const time = (seconds: number) => {
  const n = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

/** Each track can be played independently even if the other fails to load. */
export default function CompareAudioPlayer({ originalUri, cleanedUri }: Props) {
  const original = useAudioPlayer(originalUri, { updateInterval: 200 });
  const cleaned = useAudioPlayer(cleanedUri, { updateInterval: 200 });
  const originalStatus = useAudioPlayerStatus(original);
  const cleanedStatus = useAudioPlayerStatus(cleaned);
  const [active, setActive] = useState<Track>("cleaned");
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const switchLock = useRef(false);
  const trackWidth = useRef(0);
  const player = active === "original" ? original : cleaned;
  const status = active === "original" ? originalStatus : cleanedStatus;
  const ready = status.isLoaded && !status.error;
  const duration = Number.isFinite(status.duration) && status.duration > 0 ? status.duration : 0;
  const position = Number.isFinite(status.currentTime) ? Math.max(0, Math.min(duration, status.currentTime)) : 0;
  const fraction = duration > 0 ? position / duration : 0;

  useFocusEffect(useCallback(() => () => {
    try { original.pause(); cleaned.pause(); } catch { /* hook owns disposal */ }
  }, [original, cleaned]));

  const select = async (next: Track) => {
    const nextStatus = next === "original" ? originalStatus : cleanedStatus;
    if (next === active || switchLock.current || !nextStatus.isLoaded || nextStatus.error) return;
    switchLock.current = true; setSwitching(true); setError("");
    try {
      const target = next === "original" ? original : cleaned;
      if (ready) await switchPlayback(player, target);
      else { try { player.pause(); } catch { /* failed source */ } }
      setActive(next);
    } catch { setError("Could not switch audio. Try again."); }
    finally { switchLock.current = false; setSwitching(false); }
  };
  const seek = (seconds: number) => {
    if (!ready || !duration || switching) return;
    void player.seekTo(Math.max(0, Math.min(duration, seconds))).catch(() => setError("Could not seek audio. Try again."));
  };
  const tracks = [
    { id: "original" as const, status: originalStatus, player: original, uri: originalUri, label: "Original" },
    { id: "cleaned" as const, status: cleanedStatus, player: cleaned, uri: cleanedUri, label: "Cleaned" },
  ];

  return <View style={styles.container}>
    <View style={styles.titleRow}><Text style={styles.title}>LISTEN & COMPARE</Text><Text style={styles.hint}>Same position</Text></View>
    <View style={styles.toggle}>
      {tracks.map(item => {
        const unavailable = !item.status.isLoaded || !!item.status.error || switching;
        return <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: active === item.id, disabled: unavailable }}
          disabled={unavailable} onPress={() => void select(item.id)} style={[styles.choice, active === item.id && styles.choiceActive, unavailable && styles.disabled]}>
          <Text style={[styles.choiceText, active === item.id && styles.choiceTextActive]}>{item.label}</Text>
        </Pressable>;
      })}
    </View>
    <View style={styles.playerRow}>
      <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? "Pause audio" : "Play audio"}
        accessibilityState={{ disabled: !ready || switching }} disabled={!ready || switching}
        onPress={() => { setError(""); void togglePlayback(player).catch(() => setError("Could not play audio. Try again.")); }} style={[styles.play, (!ready || switching) && styles.disabled]}>
        <Feather name={status.playing ? "pause" : "play"} size={22} color={theme.COLORS.background} />
      </Pressable>
      <View style={styles.timeline}>
        <View style={styles.times}><Text style={styles.time}>{time(position)}</Text><Text style={styles.time}>{time(duration)}</Text></View>
        <Pressable accessibilityRole="adjustable" accessibilityLabel="Audio playback position"
          accessibilityState={{ disabled: !ready || switching || !duration }}
          accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(position), text: `${time(position)} of ${time(duration)}` }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={event => {
            if (event.nativeEvent.actionName === "increment") seek(position + 5);
            if (event.nativeEvent.actionName === "decrement") seek(position - 5);
          }}
          onLayout={event => { trackWidth.current = event.nativeEvent.layout.width; }}
          onPress={event => {
            const x = event.nativeEvent.locationX;
            if (Number.isFinite(x) && trackWidth.current > 0) seek(Math.max(0, Math.min(1, x / trackWidth.current)) * duration);
          }} style={styles.trackHit}>
          <View style={styles.track}><View style={[styles.progress, { width: `${fraction * 100}%` }]} /></View>
        </Pressable>
      </View>
    </View>
    {tracks.map(item => item.status.error ? <View style={styles.errorRow} key={`${item.id}-error`}>
      <Text accessibilityRole="alert" style={styles.error}>{item.label} audio unavailable: {item.status.error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Retry ${item.label} audio`} style={styles.retry}
        onPress={() => { setError(""); try { item.player.replace(item.uri); } catch { setError(`Could not retry ${item.label.toLowerCase()} audio.`); } }}><Text style={styles.retryText}>Retry</Text></Pressable>
    </View> : !item.status.isLoaded ? <Text key={`${item.id}-loading`} accessibilityLiveRegion="polite" style={styles.hint}>Preparing {item.label.toLowerCase()} audio…</Text> : null)}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: 12 }, titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: theme.COLORS.subtext, fontSize: 11, fontWeight: "800", letterSpacing: 1 }, hint: { color: theme.COLORS.subtext, fontSize: 12 },
  toggle: { flexDirection: "row", padding: 4, gap: 4, backgroundColor: theme.COLORS.background, borderRadius: 14 },
  choice: { flex: 1, borderRadius: 10, minHeight: 44, justifyContent: "center", alignItems: "center" }, choiceActive: { backgroundColor: theme.COLORS.primary },
  choiceText: { color: theme.COLORS.subtext, fontWeight: "700", fontSize: 14 }, choiceTextActive: { color: theme.COLORS.background },
  playerRow: { flexDirection: "row", alignItems: "center", gap: 14 }, play: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme.COLORS.primary, alignItems: "center", justifyContent: "center" }, disabled: { opacity: 0.5 },
  timeline: { flex: 1 }, times: { flexDirection: "row", justifyContent: "space-between" }, time: { color: theme.COLORS.subtext, fontSize: 11, fontWeight: "600" },
  trackHit: { height: 44, justifyContent: "center" }, track: { height: 5, borderRadius: 5, backgroundColor: theme.COLORS.border, overflow: "hidden" }, progress: { height: "100%", backgroundColor: theme.COLORS.primary },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 8 }, error: { color: theme.COLORS.error, fontSize: 12, flexShrink: 1 },
  retry: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }, retryText: { color: theme.COLORS.primary, fontWeight: "700" },
});
