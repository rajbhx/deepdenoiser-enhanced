import AudioPlayer from "@/src/components/audioPlayer";
import VideoPlayer from "@/src/components/videoPlayer";
import SaveButton from "@/src/components/SaveButton";
import ShareBtn from "@/src/components/shareBtn";
import * as theme from "@/src/constants/theme";
import { isProcessingMedia } from "@/src/scripts/denoiserSingleton";
import { clearRebuildableCache, getRebuildableCacheBytes, placeOutput, removeImportedMediaKind, setImportedMediaKind } from "@/src/scripts/denoiseCache";
import { PCMtoWav } from "@/src/scripts/formatHandler";
import { type MediaKind, type SelectedMedia } from "@/src/scripts/mediaSelection";
import { listPrivateMedia, type PrivateMedia, type PrivateMediaGroup } from "@/src/scripts/privateMedia";
import { assertNativeRecorderIdle, ensureRecordingWavHeader } from "@/src/scripts/recordingSafety";
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useFocusEffect } from "expo-router/react-navigation";
import { useCallback, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const groups: { id: PrivateMediaGroup; label: string }[] = [
  { id: "results", label: "Results" },
  { id: "recordings", label: "Recordings" },
  { id: "imports", label: "Imports" },
];
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.ceil(bytes)} B`;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

export default function HistoryScreen() {
  const router = useRouter();
  const [items, setItems] = useState<PrivateMedia[]>([]);
  const [group, setGroup] = useState<PrivateMediaGroup>("results");
  const [selected, setSelected] = useState<string | null>(null);
  const [openError, setOpenError] = useState("");
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const clearLock = useRef(false);

  const refresh = useCallback(() => {
    try { setItems(listPrivateMedia()); }
    catch (error) { Alert.alert("Could not load files", error instanceof Error ? error.message : String(error)); }
    void getRebuildableCacheBytes().then(setCacheBytes).catch(() => setCacheBytes(null));
  }, []);
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  const visible = items.filter(item => item.group === group);
  const total = items.reduce((sum, item) => sum + item.size, 0);

  const assertSafe = () => {
    if (isProcessingMedia()) throw new Error("Wait until recording or processing is finished.");
    assertNativeRecorderIdle();
  };
  const prepareFile = (item: PrivateMedia) => {
    assertSafe();
    if (item.group === "recordings" && !item.partial) ensureRecordingWavHeader(item.file);
  };
  const open = (item: PrivateMedia) => {
    if (selected === item.file.uri) { setSelected(null); setOpenError(""); return; }
    // Expand even when validation fails: deletion must remain reachable, but
    // preview/export stay blocked and deletion independently checks writer idle.
    setSelected(item.file.uri);
    try { prepareFile(item); setOpenError(""); }
    catch (error) { setOpenError(error instanceof Error ? error.message : String(error)); }
  };
  const remove = (item: PrivateMedia) => {
    Alert.alert("Delete private copy?", `${item.name}\n\nThis removes the app's private copy. It does not delete files you exported to your device.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => {
        try {
          assertSafe();
          setSelected(null); setOpenError("");
          if (item.file.exists) item.file.delete();
          if (item.group === "imports" && !item.file.exists) removeImportedMediaKind(item.file);
          refresh();
        } catch (error) { Alert.alert("Could not delete file", error instanceof Error ? error.message : String(error)); }
      } },
    ]);
  };
  const clearCache = () => {
    if (clearLock.current) return;
    Alert.alert("Clear temporary processing cache?", "Only rebuildable decoded and cleaned PCM cache files will be removed. Recordings, partial backups, imports and finished results are kept. Processing may take longer next time.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear cache", onPress: () => {
        if (clearLock.current) return;
        clearLock.current = true; setClearing(true);
        void (async () => {
          try { assertSafe(); await clearRebuildableCache(assertSafe); }
          catch (error) { Alert.alert("Could not clear cache", error instanceof Error ? error.message : String(error)); }
          finally { clearLock.current = false; setClearing(false); refresh(); }
        })();
      } },
    ]);
  };
  const recoverPartial = (item: PrivateMedia) => {
    Alert.alert("Recover partial backup?", "This streamed backup may be missing audio, including the final chunk. The recovered WAV will be stored in Results; the backup is kept until you delete it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Recover", onPress: () => {
        void (async () => {
          try {
            assertSafe();
            const wav = await PCMtoWav(item.file, 48000);
            await placeOutput(wav.file, `recovered_${Date.now()}_partial_original.wav`);
            setSelected(null); setGroup("results"); refresh();
          } catch (error) { Alert.alert("Could not recover backup", error instanceof Error ? error.message : String(error)); }
        })();
      } },
    ]);
  };
  const chooseKind = (item: PrivateMedia, kind: MediaKind) => {
    void (async () => {
      try { assertSafe(); await setImportedMediaKind(item.file, kind); setOpenError(""); refresh(); }
      catch (error) { Alert.alert("Could not save media type", error instanceof Error ? error.message : String(error)); }
    })();
  };
  const selectAsInput = (item: PrivateMedia) => {
    try {
      prepareFile(item);
      if (!item.kindKnown) throw new Error("Choose whether this import is audio or video first.");
      const selection: SelectedMedia[] = [{ uri: item.file.uri, name: item.name, kind: item.video ? "video" : "audio" }];
      router.push({ pathname: "/processing/process", params: {
        fileuri: encodeURIComponent(item.file.uri), filename: encodeURIComponent(item.name),
        batch: encodeURIComponent(JSON.stringify(selection)),
      } });
    } catch (error) { Alert.alert("Cannot use file", error instanceof Error ? error.message : String(error)); }
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
      <View style={{ flex: 1 }}>
        <Text style={styles.summaryText}>{formatSize(total)} in {items.length} private files</Text>
        <Text style={styles.detail}>{cacheBytes === null ? "Calculating temporary cache…" : `${formatSize(cacheBytes)} rebuildable cache`}</Text>
      </View>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear temporary processing cache"
        accessibilityState={{ disabled: clearing || cacheBytes === 0 }} disabled={clearing || cacheBytes === 0}
        onPress={clearCache} style={styles.clearButton}>
        <Text style={[styles.actionText, (clearing || cacheBytes === 0) && { opacity: 0.5 }]}>{clearing ? "Clearing…" : "Clear cache"}</Text>
      </TouchableOpacity>
    </View>
    <View style={styles.tabs}>
      {groups.map(tab => <TouchableOpacity key={tab.id} accessibilityRole="button" accessibilityState={{ selected: group === tab.id }}
        onPress={() => { setGroup(tab.id); setSelected(null); setOpenError(""); }} style={[styles.tab, group === tab.id && styles.tabActive]}>
        <Text style={[styles.tabText, group === tab.id && styles.tabTextActive]}>{tab.label}</Text>
      </TouchableOpacity>)}
    </View>
    <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
      {!visible.length && <Text style={styles.empty}>No {group} yet.</Text>}
      {visible.map(item => {
        const expanded = selected === item.file.uri;
        const canExport = item.kindKnown && (item.video ? /\.mp4$/i.test(item.name) : /\.wav$/i.test(item.name));
        return <View style={styles.card} key={item.file.uri}>
          <TouchableOpacity style={styles.row} onPress={() => open(item)} accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${formatSize(item.size)}`} accessibilityState={{ expanded }}>
            <View style={styles.icon}><Feather name={!item.kindKnown ? "file" : item.video ? "film" : "music"} size={19} color={theme.COLORS.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={2} style={styles.name}>{item.name}</Text>
              <Text style={styles.detail}>{formatSize(item.size)}{item.modified ? ` · ${new Date(item.modified).toLocaleDateString()}` : ""}{!item.kindKnown ? " · Choose type" : ""}</Text>
            </View>
            <Feather name={expanded ? "chevron-up" : "chevron-down"} size={20} color={theme.COLORS.subtext} />
          </TouchableOpacity>
          {expanded && <View style={styles.expanded}>
            {!!openError && <Text accessibilityRole="alert" style={styles.error}>Cannot preview this file: {openError} You can still request deletion below.</Text>}
            {!openError && item.group === "imports" && <View style={styles.kindSection}>
              <Text style={styles.note}>{item.kindKnown ? "Media type (change if incorrect):" : "Choose the media type before previewing or denoising this older import:"}</Text>
              <View style={styles.kindRow}>
                {(["audio", "video"] as const).map(kind => <TouchableOpacity key={kind} accessibilityRole="button"
                  accessibilityState={{ selected: item.kindKnown && item.video === (kind === "video") }}
                  onPress={() => chooseKind(item, kind)} style={[styles.kindButton, item.kindKnown && item.video === (kind === "video") && styles.kindActive]}>
                  <Text style={[styles.actionText, item.kindKnown && item.video === (kind === "video") && styles.kindActiveText]}>{kind === "audio" ? "Audio" : "Video"}</Text>
                </TouchableOpacity>)}
              </View>
            </View>}
            {!openError && (item.partial ? <Text style={styles.note}>This cache backup can be incomplete and may be removed by Android. Recover it to Results before relying on it.</Text>
              : !item.kindKnown ? null : item.video ? <VideoPlayer uri={item.file.uri} name={item.name} /> : <AudioPlayer uri={item.file.uri} name={item.name} />)}
            <View style={styles.actions}>
              {!openError && item.partial && <TouchableOpacity accessibilityRole="button" onPress={() => recoverPartial(item)} style={styles.action}>
                <Feather name="refresh-cw" size={17} color={theme.COLORS.primary} /><Text style={styles.actionText}>Recover WAV</Text>
              </TouchableOpacity>}
              {!openError && canExport && <SaveButton file={item.file} label="Save" style={[theme.Styles.button, styles.save]}
                onError={error => Alert.alert("Could not save", error.message)} beforeSave={() => prepareFile(item)} />}
              {!openError && item.kindKnown && item.group !== "results" && !item.partial && <TouchableOpacity accessibilityRole="button" onPress={() => selectAsInput(item)} style={styles.action}>
                <Feather name="zap" size={17} color={theme.COLORS.primary} /><Text style={styles.actionText}>Denoise</Text>
              </TouchableOpacity>}
              {!openError && !item.partial && <ShareBtn uri={item.file.uri} beforeShare={() => prepareFile(item)} />}
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
  back: { padding: 10, minWidth: 44, minHeight: 44 }, heading: { color: theme.COLORS.text, fontSize: 22, fontWeight: "800" },
  intro: { color: theme.COLORS.subtext, fontSize: 14, lineHeight: 21, marginTop: 8 },
  summary: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 9, backgroundColor: theme.COLORS.surface, borderRadius: 14, padding: 14, marginTop: 20 },
  summaryText: { color: theme.COLORS.text, fontSize: 13, fontWeight: "700" }, clearButton: { padding: 8, minHeight: 44, justifyContent: "center" },
  tabs: { flexDirection: "row", gap: 8, marginVertical: 18 },
  tab: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderColor: theme.COLORS.border, borderWidth: 1, borderRadius: 12, paddingVertical: 10 },
  tabActive: { backgroundColor: theme.COLORS.primary, borderColor: theme.COLORS.primary },
  tabText: { color: theme.COLORS.subtext, fontWeight: "700", fontSize: 12 }, tabTextActive: { color: theme.COLORS.background },
  list: { gap: 10, paddingBottom: 40 }, card: { backgroundColor: theme.COLORS.surface, borderColor: theme.COLORS.border, borderWidth: 1, borderRadius: 16, padding: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  icon: { width: 42, height: 42, borderRadius: 12, backgroundColor: "rgba(0,229,255,0.09)", alignItems: "center", justifyContent: "center" },
  name: { color: theme.COLORS.text, fontSize: 13, fontWeight: "700" }, detail: { color: theme.COLORS.subtext, fontSize: 11, marginTop: 4 },
  expanded: { gap: 14, paddingTop: 16 }, actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 16 },
  save: { minHeight: 44, paddingHorizontal: 18 }, action: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44 },
  actionText: { color: theme.COLORS.primary, fontSize: 12, fontWeight: "700" }, delete: { marginLeft: "auto", padding: 10, minWidth: 44, minHeight: 44 },
  kindSection: { gap: 8 }, kindRow: { flexDirection: "row", gap: 8 },
  kindButton: { borderWidth: 1, borderColor: theme.COLORS.border, borderRadius: 10, paddingHorizontal: 18, minHeight: 44, justifyContent: "center" },
  kindActive: { backgroundColor: theme.COLORS.primary, borderColor: theme.COLORS.primary }, kindActiveText: { color: theme.COLORS.background },
  empty: { textAlign: "center", color: theme.COLORS.subtext, paddingVertical: 35 },
  note: { color: theme.COLORS.subtext, fontSize: 12, lineHeight: 18 }, error: { color: theme.COLORS.error, fontSize: 13, lineHeight: 19 },
});
