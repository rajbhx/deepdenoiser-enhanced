import * as theme from "@/src/constants/theme";
import { togglePlayback } from "@/src/scripts/comparePlayback";
import Feather from "@expo/vector-icons/Feather";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useFocusEffect } from "expo-router/react-navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";

interface AudioPlayerProps { uri: string; name: string }

const formatTime = (seconds: number) => {
  const n = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

export default function AudioPlayer({ uri, name }: AudioPlayerProps) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const [error, setError] = useState("");
  const trackWidth = useSharedValue(0);
  const progress = useSharedValue(0);
  const isSeeking = useSharedValue(false);
  const isSeekingRef = useRef(false);
  const ready = status.isLoaded && !status.error;

  const seek = useCallback((seconds: number) => {
    if (!ready || status.duration <= 0) return;
    void player.seekTo(Math.max(0, Math.min(status.duration, seconds)))
      .catch(() => setError("Could not seek audio. Try again."));
  }, [player, ready, status.duration]);
  const seekFraction = useCallback((fraction: number) => seek(fraction * status.duration), [seek, status.duration]);
  const syncSeekingToRef = (value: boolean) => { isSeekingRef.current = value; };

  useFocusEffect(useCallback(() => () => {
    try { player.pause(); } catch { /* hook owns disposal */ }
  }, [player]));
  useEffect(() => {
    if (!isSeekingRef.current) progress.value = status.duration > 0 ? Math.max(0, Math.min(1, status.currentTime / status.duration)) : 0;
  }, [progress, status.currentTime, status.duration]);

  /* eslint-disable react-hooks/immutability, react-hooks/refs -- shared values and refs are accessed by gesture worklets, not during render */
  const pan = Gesture.Pan().enabled(ready).minDistance(5)
    .onBegin(() => { isSeeking.value = true; runOnJS(syncSeekingToRef)(true); })
    .onUpdate(event => {
      if (trackWidth.value > 0) progress.value = Math.max(0, Math.min(1, event.x / trackWidth.value));
    })
    .onEnd(event => {
      if (trackWidth.value > 0) {
        progress.value = Math.max(0, Math.min(1, event.x / trackWidth.value));
        runOnJS(seekFraction)(progress.value);
      }
    })
    .onFinalize(() => { isSeeking.value = false; runOnJS(syncSeekingToRef)(false); });
  const tap = Gesture.Tap().enabled(ready).onEnd((event, success) => {
    if (success && trackWidth.value > 0) {
      progress.value = Math.max(0, Math.min(1, event.x / trackWidth.value));
      runOnJS(seekFraction)(progress.value);
    }
  });
  /* eslint-enable react-hooks/immutability, react-hooks/refs */
  const fillStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));
  const knobStyle = useAnimatedStyle(() => ({ left: `${progress.value * 100}%`, transform: [{ scale: isSeeking.value ? 1.2 : 1 }] }));

  return <View style={styles.container}>
    <GestureHandlerRootView style={styles.audioControls}>
      <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? "Pause audio" : "Play audio"}
        accessibilityState={{ disabled: !ready }} disabled={!ready}
        style={[styles.playButton, !ready && { opacity: 0.5 }]}
        onPress={() => { setError(""); void togglePlayback(player).catch(() => setError("Could not play audio. Try again.")); }}>
        <Feather name={status.playing ? "pause" : "play"} size={24} color={theme.COLORS.background} />
      </Pressable>
      <View style={styles.sliderSection}>
        <View style={styles.timeLabels}><Text style={styles.timeText}>{formatTime(status.currentTime)}</Text><Text style={styles.timeText}>{formatTime(status.duration)}</Text></View>
        <GestureDetector gesture={Gesture.Race(pan, tap)}>
          <View accessible accessibilityRole="adjustable" accessibilityLabel="Audio playback position"
            accessibilityState={{ disabled: !ready }}
            accessibilityValue={{ min: 0, max: Math.max(0, Math.round(status.duration)), now: Math.max(0, Math.min(Math.round(status.duration), Math.round(status.currentTime))), text: `${formatTime(status.currentTime)} of ${formatTime(status.duration)}` }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={event => {
              if (event.nativeEvent.actionName === "increment") seek(status.currentTime + 5);
              if (event.nativeEvent.actionName === "decrement") seek(status.currentTime - 5);
            }}
            style={styles.trackContainer} onLayout={event => { trackWidth.value = event.nativeEvent.layout.width; }}>
            <View style={styles.track}><Animated.View style={[styles.progressFill, fillStyle]} /></View>
            <Animated.View style={[styles.knob, knobStyle]} />
          </View>
        </GestureDetector>
      </View>
    </GestureHandlerRootView>
    {!status.isLoaded && !status.error && <Text accessibilityLiveRegion="polite" style={styles.hint}>Preparing audio…</Text>}
    {!!status.error && <View style={styles.errorRow}>
      <Text accessibilityRole="alert" style={styles.error}>Could not load audio: {status.error}</Text>
      <Pressable accessibilityRole="button" style={styles.retry} onPress={() => { setError(""); try { player.replace(uri); } catch { setError("Could not retry audio."); } }}><Text style={styles.retryText}>Retry</Text></Pressable>
    </View>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <View style={styles.divider} />
    <View style={styles.fileNameContainer}><Feather name="music" size={14} color={theme.COLORS.primary} style={{ marginRight: 8 }} />
      <Text style={styles.fileName} numberOfLines={1}>{name}</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  container: { width: "100%", backgroundColor: "transparent" }, audioControls: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  playButton: { width: 48, height: 48, borderRadius: 24, marginRight: 16, backgroundColor: theme.COLORS.primary, alignItems: "center", justifyContent: "center", elevation: 4 },
  sliderSection: { flex: 1 }, timeLabels: { flexDirection: "row", justifyContent: "space-between" },
  timeText: { color: theme.COLORS.subtext, fontSize: 10, fontWeight: "700" },
  trackContainer: { height: 44, justifyContent: "center" }, track: { height: 6, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: theme.COLORS.primary }, knob: { position: "absolute", width: 14, height: 14, borderRadius: 7, backgroundColor: theme.COLORS.white, marginLeft: -7, elevation: 3 },
  hint: { color: theme.COLORS.subtext, fontSize: 12 }, errorRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  error: { color: theme.COLORS.error, fontSize: 12, flexShrink: 1 }, retry: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }, retryText: { color: theme.COLORS.primary, fontWeight: "700" },
  divider: { height: 1, backgroundColor: "rgba(255,255,255,0.05)", marginVertical: 4 },
  fileNameContainer: { flexDirection: "row", alignItems: "center", paddingTop: 8 }, fileName: { color: theme.COLORS.text, fontSize: theme.FONT_SIZE.small, fontWeight: "600", flex: 1 },
});
