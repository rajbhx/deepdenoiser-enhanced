import * as theme from "@/src/constants/theme";
import { useFocusEffect } from "expo-router/react-navigation";
import { useVideoPlayer, VideoView, type VideoPlayer as ExpoVideoPlayer } from "expo-video";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

interface VideoPlayerProps { uri: string; name: string }
const visiblePlayers = new Set<ExpoVideoPlayer>();

export default function VideoPlayer({ uri, name }: VideoPlayerProps) {
  const [error, setError] = useState("");
  const player = useVideoPlayer(uri, instance => { instance.loop = false; instance.muted = false; });

  useEffect(() => {
    visiblePlayers.add(player);
    const playing = player.addListener("playingChange", event => {
      if (!event.isPlaying) return;
      // Original and result videos can coexist on one screen; never mix them.
      for (const other of visiblePlayers) if (other !== player) {
        try { other.pause(); } catch { /* another view may already be disposed */ }
      }
    });
    const status = player.addListener("statusChange", event => {
      if (event.status === "error") setError(event.error?.message || "Could not load this video.");
      else if (event.status === "readyToPlay") setError("");
    });
    return () => { playing.remove(); status.remove(); visiblePlayers.delete(player); };
  }, [player]);

  useFocusEffect(useCallback(() => () => {
    try { player.pause(); } catch { /* hook owns disposal */ }
  }, [player]));

  return <View style={styles.card}>
    <View style={styles.videoContainer}>
      <VideoView style={styles.video} player={player} fullscreenOptions={{ enable: true }} contentFit="contain" />
    </View>
    {!!error && <View style={styles.errorRow}>
      <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Retry ${name}`} style={styles.retry}
        onPress={() => { setError(""); void player.replaceAsync(uri).catch(() => setError("Could not retry this video.")); }}><Text style={styles.retryText}>Retry</Text></Pressable>
    </View>}
    <View style={styles.footer}><Text style={styles.title} numberOfLines={1}>{name}</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.COLORS.surface, borderRadius: 24, borderWidth: 1, borderColor: theme.COLORS.border, overflow: "hidden", width: "100%" },
  videoContainer: { width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000", justifyContent: "center", alignItems: "center" },
  video: { width: "100%", height: "100%" }, footer: { padding: theme.SPACING.medium, backgroundColor: theme.COLORS.surface },
  title: { color: theme.COLORS.text, fontSize: theme.FONT_SIZE.body, fontWeight: "700" },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 }, error: { color: theme.COLORS.error, flex: 1, fontSize: 12 },
  retry: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }, retryText: { color: theme.COLORS.primary, fontWeight: "700" },
});
