import * as theme from "@/src/constants/theme";
import { switchPlayback, togglePlayback } from "@/src/scripts/comparePlayback";
import Feather from "@expo/vector-icons/Feather";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useFocusEffect } from "expo-router/react-navigation";
import React, { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

interface Props { originalUri: string; cleanedUri: string }

/** Two prepared players let listeners switch sources without losing position. */
export default function CompareAudioPlayer({ originalUri, cleanedUri }: Props) {
  const original = useAudioPlayer(originalUri, { updateInterval: 200 });
  const cleaned = useAudioPlayer(cleanedUri, { updateInterval: 200 });
  const originalStatus = useAudioPlayerStatus(original);
  const cleanedStatus = useAudioPlayerStatus(cleaned);
  const [active, setActive] = useState<"original" | "cleaned">("cleaned");
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const switchLock = useRef(false);
  const trackWidth = useRef(0);
  const player = active === "original" ? original : cleaned;
  const status = active === "original" ? originalStatus : cleanedStatus;
  const ready = originalStatus.isLoaded && cleanedStatus.isLoaded;
  const fraction = status.duration > 0 ? Math.min(1, Math.max(0, status.currentTime / status.duration)) : 0;

  useFocusEffect(useCallback(() => () => {
    try { original.pause(); cleaned.pause(); } catch { /* hook owns disposal */ }
  }, [original, cleaned]));

  const select = async (next: "original" | "cleaned") => {
    if (next === active || switchLock.current || !ready) return;
    switchLock.current = true;
    setSwitching(true); setError("");
    try {
      await switchPlayback(player, next === "original" ? original : cleaned);
      setActive(next);
    } catch {
      setError("Could not switch audio. Try again.");
    } finally {
      switchLock.current = false;
      setSwitching(false);
    }
  };
  const time = (seconds: number) => {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>LISTEN & COMPARE</Text>
        <Text style={styles.hint}>Same position</Text>
      </View>
      <View style={styles.toggle}>
        {(["original", "cleaned"] as const).map((item) => (
          <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: active === item, disabled: !ready || switching }}
            disabled={!ready || switching} onPress={() => void select(item)}
            style={[styles.choice, active === item && styles.choiceActive]}>
            <Text style={[styles.choiceText, active === item && styles.choiceTextActive]}>
              {item === "original" ? "Original" : "Cleaned"}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.playerRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? "Pause audio" : "Play audio"}
          disabled={!ready || switching} onPress={() => { void togglePlayback(player).catch(() => setError("Could not play audio.")); }} style={styles.play}>
          <Feather name={status.playing ? "pause" : "play"} size={22} color={theme.COLORS.background} />
        </Pressable>
        <View style={styles.timeline}>
          <View style={styles.times}><Text style={styles.time}>{time(status.currentTime)}</Text><Text style={styles.time}>{time(status.duration)}</Text></View>
          <Pressable accessibilityRole="adjustable" accessibilityLabel="Audio playback position"
            onLayout={(event) => { trackWidth.current = event.nativeEvent.layout.width; }}
            onPress={(event) => {
              if (ready && trackWidth.current > 0 && status.duration > 0) {
                const p = Math.max(0, Math.min(1, event.nativeEvent.locationX / trackWidth.current));
                void player.seekTo(p * status.duration).catch(() => setError("Could not seek audio."));
              }
            }} style={styles.trackHit}>
            <View style={styles.track}><View style={[styles.progress, { width: `${fraction * 100}%` }]} /></View>
          </Pressable>
        </View>
      </View>
      {!ready && <Text style={styles.hint}>Preparing both audio tracks…</Text>}
      {!!error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: theme.COLORS.subtext, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  hint: { color: theme.COLORS.subtext, fontSize: 12 },
  toggle: { flexDirection: "row", padding: 4, gap: 4, backgroundColor: theme.COLORS.background, borderRadius: 14 },
  choice: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  choiceActive: { backgroundColor: theme.COLORS.primary },
  choiceText: { color: theme.COLORS.subtext, fontWeight: "700", fontSize: 14 },
  choiceTextActive: { color: theme.COLORS.background },
  playerRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  play: { width: 45, height: 45, borderRadius: 23, backgroundColor: theme.COLORS.primary, alignItems: "center", justifyContent: "center" },
  timeline: { flex: 1 },
  times: { flexDirection: "row", justifyContent: "space-between" },
  time: { color: theme.COLORS.subtext, fontSize: 11, fontWeight: "600" },
  trackHit: { height: 24, justifyContent: "center" },
  track: { height: 5, borderRadius: 5, backgroundColor: theme.COLORS.border, overflow: "hidden" },
  progress: { height: "100%", backgroundColor: theme.COLORS.primary },
  error: { color: theme.COLORS.error, fontSize: 12 },
});
