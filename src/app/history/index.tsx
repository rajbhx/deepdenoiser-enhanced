import AudioPlayer from "@/src/components/audioPlayer";
import VideoPlayer from "@/src/components/videoPlayer";
import SaveButton from "@/src/components/SaveButton";
import ShareBtn from "@/src/components/shareBtn";
import * as theme from "@/src/constants/theme";
import { isProcessingMedia } from "@/src/scripts/denoiserSingleton";
import { placeOutput } from "@/src/scripts/denoiseCache";
import { PCMtoWav } from "@/src/scripts/formatHandler";
import { mediaKind, type SelectedMedia } from "@/src/scripts/mediaSelection";
import { listPrivateMedia, type PrivateMedia, type PrivateMediaGroup } from "@/src/scripts/privateMedia";
import { ensureRecordingWavHeader } from "@/src/scripts/recordingSafety";
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useFocusEffect } from "expo-router/react-navigation";
import { useCallback, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const groups: { id: PrivateMediaGroup; label: string }[] = [
  { id: "results", label: "Results" },
  { id: "recordings", label: "Recordings" },
  { id: "imports", label: "Imports" },
];
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

export default function HistoryScreen() {
  const router = useRouter();
  const [items, setItems] = useState<PrivateMedia[]>([]);
  const [group, setGroup] = useState<PrivateMediaGroup>("results");
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(() => {
    try { setItems(listPrivateMedia()); }
    catch (error) { Alert.alert("Could not load files", error instanceof Error ? error.message : String(error)); }
  }, []);
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  const visible = items.filter(item => item.group === group);
  const total = items.reduce((sum, item) => sum + item.size, 0);

  const open = (item: PrivateMedia) => {
    if (selected === item.file.uri) { setSelected(null); return; }
    try {
      if (item.group === "recordings" && !item.partial) {
        if (isProcessingMedia()) throw new Error("Wait until the current recording or processing is finished.");
        ensureRecordingWavHeader(item.file);
      }
      setSelected(item.file.uri);
    } catch (error) {
      Alert.alert("Could not open recording", error instanceof Error ? error.message : String(error));
    }
  };
  const remove = (item: PrivateMedia) => {
    Alert.alert("Delete private copy?", `${item.name}\n\nThis removes the app's private copy. It does not delete files you exported to your device.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => {
        try {
          if (isProcessingMedia()) throw new Error("Wait until recording or processing is finished before deleting files.");
          setSelected(null);
          if (item.file.exists) item.file.delete();
          refresh();
        } catch (error) { Alert.alert("Could not delete file", error instanceof Error ? error.message : String(error)); }
      } },
    ]);
  };
  const recoverPartial = (item: PrivateMedia) => {
    Alert.alert("Recover partial backup?", "This streamed backup may be missing audio, including the final chunk. The recovered WAV will be stored in Results; the backup is kept until you delete it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Recover", onPress: () => {
        void (async () => {
          try {
            if (isProcessingMedia()) throw new Error("Wait until recording or processing is finished.");
            const wav = await PCMtoWav(item.file, 48000);
            await placeOutput(wav.file, `recovered_${Date.now()}_partial_original.wav`);
            setSelected(null); setGroup("results"); refresh();
          } catch (error) { Alert.alert("Could not recover backup", error instanceof Error ? error.message : String(error)); }
        })();
      } },
    ]);
  };
  const useInput = (item: PrivateMedia) => {
    const selection: SelectedMedia[] = [{ uri: item.file.uri, name: item.name, kind: mediaKind(item.name) }];
    router.push({ pathname: "/processing/process", params: {
      fileuri: encodeURIComponent(item.file.uri), filename: encodeURIComponent(item.name),
      batch: encodeURIComponent(JSON.stringify(selection)),
    } });
  };

  return <SafeAreaView style={theme.Styles.container}>
    <View style={styles.header}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={styles.back}>
        <Feather name="arrow-left" size={24} color={theme.COLORS.text} />
      </TouchableOpacity>
      <Text style={styles.heading}>Your files</Text>
    </View>
    <Text style={styles.intro}>Recover recordings, revisit results, or remove private copies.</Text>
    <View style={styles.summary}>
      <Feather name="hard-drive" size={18} color={theme.COLORS.primary} />
      <Text style={styles.summaryText}>{formatSize(total)} in {items.length} private files</Text>
    </View>
    <View style={styles.tabs}>
      {groups.map(tab => <TouchableOpacity key={tab.id} accessibilityRole="button"
        onPress={() => { setGroup(tab.id); setSelected(null); }} style={[styles.tab, group === tab.id && styles.tabActive]}>
        <Text style={[styles.tabText, group === tab.id && styles.tabTextActive]}>{tab.label}</Text>
      </TouchableOpacity>)}
    </View>
    <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
      {!visible.length && <Text style={styles.empty}>No {group} yet.</Text>}
      {visible.map(item => {
        const expanded = selected === item.file.uri;
        const canExport = /\.(wav|mp4)$/i.test(item.name);
        return <View style={styles.card} key={item.file.uri}>
          <TouchableOpacity style={styles.row} onPress={() => open(item)} accessibilityRole="button">
            <View style={styles.icon}><Feather name={item.video ? "film" : "music"} size={19} color={theme.COLORS.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={2} style={styles.name}>{item.name}</Text>
              <Text style={styles.detail}>{formatSize(item.size)}{item.modified ? ` · ${new Date(item.modified).toLocaleDateString()}` : ""}</Text>
            </View>
            <Feather name={expanded ? "chevron-up" : "chevron-down"} size={20} color={theme.COLORS.subtext} />
          </TouchableOpacity>
          {expanded && <View style={styles.expanded}>
            {item.partial ? <Text style={styles.note}>This cache backup can be incomplete and may be removed by Android. Recover it to Results before relying on it.</Text>
              : item.video ? <VideoPlayer uri={item.file.uri} name={item.name} /> : <AudioPlayer uri={item.file.uri} name={item.name} />}
            <View style={styles.actions}>
              {item.partial && <TouchableOpacity onPress={() => recoverPartial(item)} style={styles.action}>
                <Feather name="refresh-cw" size={17} color={theme.COLORS.primary} /><Text style={styles.actionText}>Recover WAV</Text>
              </TouchableOpacity>}
              {canExport && <SaveButton file={item.file} label="Save" style={[theme.Styles.button, styles.save]}
                onError={error => Alert.alert("Could not save", error.message)} />}
              {item.group !== "results" && !item.partial && <TouchableOpacity onPress={() => useInput(item)} style={styles.action}>
                <Feather name="zap" size={17} color={theme.COLORS.primary} /><Text style={styles.actionText}>Denoise</Text>
              </TouchableOpacity>}
              {!item.partial && <ShareBtn uri={item.file.uri} />}
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete ${item.name}`} onPress={() => remove(item)} style={styles.delete}>
                <Feather name="trash-2" size={20} color={theme.COLORS.error} />
              </TouchableOpacity>
            </View>
          </View>}
        </View>;
      })}
      <Text style={styles.note}>These copies live inside the app. Export anything you want to keep before clearing app data or uninstalling.</Text>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  header: { height: 60, flexDirection: "row", alignItems: "center", gap: 16 },
  back: { padding: 6 }, heading: { color: theme.COLORS.text, fontSize: 22, fontWeight: "800" },
  intro: { color: theme.COLORS.subtext, fontSize: 14, lineHeight: 21, marginTop: 8 },
  summary: { flexDirection: "row", alignItems: "center", gap: 9, backgroundColor: theme.COLORS.surface, borderRadius: 14, padding: 14, marginTop: 20 },
  summaryText: { color: theme.COLORS.text, fontSize: 13, fontWeight: "700" },
  tabs: { flexDirection: "row", gap: 8, marginVertical: 18 },
  tab: { flex: 1, alignItems: "center", borderColor: theme.COLORS.border, borderWidth: 1, borderRadius: 12, paddingVertical: 10 },
  tabActive: { backgroundColor: theme.COLORS.primary, borderColor: theme.COLORS.primary },
  tabText: { color: theme.COLORS.subtext, fontWeight: "700", fontSize: 12 },
  tabTextActive: { color: theme.COLORS.background },
  list: { gap: 10, paddingBottom: 40 },
  card: { backgroundColor: theme.COLORS.surface, borderColor: theme.COLORS.border, borderWidth: 1, borderRadius: 16, padding: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 42, height: 42, borderRadius: 12, backgroundColor: "rgba(0,229,255,0.09)", alignItems: "center", justifyContent: "center" },
  name: { color: theme.COLORS.text, fontSize: 13, fontWeight: "700" }, detail: { color: theme.COLORS.subtext, fontSize: 11, marginTop: 4 },
  expanded: { gap: 14, paddingTop: 16 }, actions: { flexDirection: "row", alignItems: "center", gap: 16 },
  save: { height: 42, paddingHorizontal: 18 }, action: { flexDirection: "row", alignItems: "center", gap: 4 },
  actionText: { color: theme.COLORS.primary, fontSize: 12, fontWeight: "700" }, delete: { marginLeft: "auto", padding: 6 },
  empty: { textAlign: "center", color: theme.COLORS.subtext, paddingVertical: 35 },
  note: { color: theme.COLORS.subtext, fontSize: 12, lineHeight: 18, marginTop: 20 },
});
