import AudioPlayer from "@/src/components/audioPlayer";
import ErrorModal from "@/src/components/ErrorModal";
import SettingsSidebar from "@/src/components/SettingsSidebar";
import VideoPlayer from "@/src/components/videoPlayer";
import * as theme from "@/src/constants/theme";
import { cleanupTempCache, importToDocuments, readImportedMediaKind, setImportedMediaKind } from "@/src/scripts/denoiseCache";
import { pickDocument } from "@/src/scripts/documentPicker";
import { MAX_BATCH_FILES, mediaKind, type SelectedMedia } from "@/src/scripts/mediaSelection";
import { claimSharedBatch, finishSharedBatch } from "@/src/scripts/shareClaim";
import { importSharedMedia } from "@/src/scripts/sharedImport";
import { isCurrentShare, useRawIncomingShare } from "@/src/scripts/useRawIncomingShare";
import { useProcessingBusy } from "@/src/scripts/useProcessingBusy";
import Feather from "@expo/vector-icons/Feather";
import { Host, LoadingIndicator } from "@expo/ui/jetpack-compose";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { useIsFocused, useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function HomeScreen() {
  const router = useRouter();
  const focused = useIsFocused();
  const processingBusy = useProcessingBusy();
  // Do not consume the next queued share until this screen has lost and regained focus.
  const navigatingFromShare = useRef(false);
  useEffect(() => { if (focused) navigatingFromShare.current = false; }, [focused]);
  const [files, setFiles] = useState<SelectedMedia[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("Preparing media…");
  const [error, setError] = useState<Error | null>(null);
  const [isErrorModalVisible, setIsErrorModalVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const importInFlightRef = useRef(false);
  const reportedShareError = useRef<Error | null>(null);
  const { payloads: sharedPayloads, generation: shareGeneration, consume: consumeShare, discardUnreadable, error: shareError } = useRawIncomingShare();

  useEffect(() => {
    if (!focused || processingBusy || navigatingFromShare.current || importInFlightRef.current) return;
    if (shareError) {
      if (reportedShareError.current !== shareError) {
        reportedShareError.current = shareError;
        Alert.alert("Could not read shared media", `${shareError.message}\nPlease share the files again.`, [
          { text: "Dismiss", onPress: discardUnreadable },
        ]);
      }
      return;
    }
    reportedShareError.current = null;
    if (!sharedPayloads.length || !isCurrentShare(sharedPayloads, shareGeneration)) return;
    const claim = claimSharedBatch([shareGeneration]);
    if (!claim) return;
    importInFlightRef.current = true;
    void (async () => {
      try {
        setLoadingLabel("Preparing shared files…"); setIsLoading(true);
        const selection = await importSharedMedia(sharedPayloads,
          (current, total) => setLoadingLabel(`Importing shared file ${current} of ${total}…`));
        navigatingFromShare.current = true;
        consumeShare(sharedPayloads, shareGeneration);
        router.push({ pathname: "/processing/process", params: {
          fileuri: encodeURIComponent(selection[0].uri),
          filename: encodeURIComponent(selection[0].name),
          batch: encodeURIComponent(JSON.stringify(selection)),
        } });
      } catch (copyError) {
        navigatingFromShare.current = false;
        consumeShare(sharedPayloads, shareGeneration);
        const message = copyError instanceof Error ? copyError.message : String(copyError);
        Alert.alert("Could not import shared media", message, [{ text: "OK", onPress: () => router.navigate("/(tabs)") }]);
      } finally {
        importInFlightRef.current = false;
        finishSharedBatch(claim);
        setIsLoading(false);
      }
    })();
  }, [sharedPayloads, shareGeneration, shareError, consumeShare, discardUnreadable, router, isLoading, focused, processingBusy]);

  useEffect(() => { void cleanupTempCache(); }, []);

  const handleImportFiles = async () => {
    if (importInFlightRef.current) return;
    importInFlightRef.current = true;
    setLoadingLabel("Opening file picker…"); setIsLoading(true);
    const added: SelectedMedia[] = [];
    try {
      const result = await pickDocument({ type: ["audio/*", "video/*"], copyToCacheDirectory: false, multiple: true });
      if (result.canceled || !result.assets?.length) return;
      const seen = new Set(files.map(item => item.uri));
      for (let i = 0; i < result.assets.length; i++) {
        const asset = result.assets[i];
        setLoadingLabel(`Importing ${i + 1} of ${result.assets.length}…`);
        const detectedKind = mediaKind(asset.name, asset.mimeType);
        const imported = await importToDocuments(asset.uri, asset.name, undefined, detectedKind);
        // Count immutable imported identities, not raw picker selections.
        if (seen.has(imported.uri)) continue;
        if (seen.size >= MAX_BATCH_FILES) {
          Alert.alert("Batch is full", `A batch can contain up to ${MAX_BATCH_FILES} unique files. The remaining selection was not added. Any copied files remain in Your files.`);
          break;
        }
        seen.add(imported.uri);
        added.push({ uri: imported.uri, name: asset.name, kind: readImportedMediaKind(imported) ?? detectedKind });
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError : new Error(String(importError)));
      setIsErrorModalVisible(true);
    } finally {
      if (added.length) {
        setFiles((previous) => {
          const seen = new Set(previous.map((item) => item.uri));
          return [...previous, ...added.filter((item) => {
            if (seen.has(item.uri)) return false;
            seen.add(item.uri); return true;
          })];
        });
      }
      importInFlightRef.current = false;
      setIsLoading(false);
    }
  };

  const changeKind = async (file: SelectedMedia) => {
    if (importInFlightRef.current) return;
    importInFlightRef.current = true;
    setLoadingLabel("Updating media type…"); setIsLoading(true);
    try {
      const next = file.kind === "audio" ? "video" : "audio";
      await setImportedMediaKind(new File(file.uri), next);
      setFiles(previous => previous.map(item => item.uri === file.uri ? { ...item, kind: next } : item));
    } catch (kindError) {
      Alert.alert("Could not change media type", kindError instanceof Error ? kindError.message : String(kindError));
    } finally { importInFlightRef.current = false; setIsLoading(false); }
  };

  const proceed = () => {
    if (!files.length) return;
    router.push({ pathname: "/processing/process", params: {
      fileuri: encodeURIComponent(files[0].uri),
      filename: encodeURIComponent(files[0].name),
      batch: encodeURIComponent(JSON.stringify(files)),
    } });
  };

  return (
    <SafeAreaView style={theme.Styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <Image source={require("@/assets/images/splash-icon.png")} style={styles.logo} />
            <View style={styles.brandText}>
              <Text style={styles.eyebrow}>PRIVATE · ON-DEVICE AI</Text>
              <Text style={styles.title}>DeepDenoiser</Text>
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open your files" disabled={isLoading} accessibilityState={{ disabled: isLoading }} onPress={() => router.push("/history")} style={styles.settings}>
              <Feather name="folder" size={21} color={theme.COLORS.text} />
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open settings" disabled={isLoading} accessibilityState={{ disabled: isLoading }} onPress={() => setSettingsVisible(true)} style={styles.settings}>
              <Feather name="settings" size={21} color={theme.COLORS.text} />
            </TouchableOpacity>
          </View>
          <Text style={styles.subtitle}>Cleaner audio, wherever you are.</Text>
        </View>

        {processingBusy && sharedPayloads.length > 0 && <Text style={styles.actionSubtitle} accessibilityLiveRegion="polite">
          Shared files are waiting. Finish the current recording or processing first.
        </Text>}
        {!files.length ? (
          <View style={styles.actions}>
            <TouchableOpacity accessibilityRole="button" style={[styles.heroCard, isLoading && styles.dim]} onPress={handleImportFiles} disabled={isLoading} activeOpacity={0.8}>
              <View style={styles.heroTop}>
                <View style={styles.heroIcon}><Feather name="upload-cloud" size={27} color={theme.COLORS.primary} /></View>
                <Feather name="arrow-up-right" size={20} color={theme.COLORS.primary} />
              </View>
              <Text style={styles.heroTitle}>Import media</Text>
              <Text style={styles.heroSubtitle}>Select audio or video. Choose multiple files for a batch.</Text>
              <View style={styles.tagRow}><Text style={styles.tag}>AUDIO</Text><Text style={styles.tag}>VIDEO</Text><Text style={styles.tag}>BATCH</Text></View>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" style={styles.recordCard} onPress={() => router.push("/recording")} disabled={isLoading}>
              <View style={styles.recordIcon}><Feather name="mic" size={23} color={theme.COLORS.error} /></View>
              <View style={{ flex: 1 }}><Text style={styles.actionTitle}>Record voice</Text><Text style={styles.actionSubtitle}>Processed during recording; listen after stopping</Text></View>
              <Feather name="chevron-right" size={20} color={theme.COLORS.subtext} />
            </TouchableOpacity>
            <View style={styles.privacy}><Feather name="shield" size={16} color={theme.COLORS.success} /><Text style={styles.privacyText}>Processing is on-device. Android backups or device transfers may include app files.</Text></View>
          </View>
        ) : (
          <View style={styles.selection}>
            <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>Selected media</Text><Text style={styles.actionSubtitle}>{files.length} of {MAX_BATCH_FILES} files · processed one at a time</Text></View>
              <TouchableOpacity onPress={() => setFiles([])} disabled={isLoading}><Text style={styles.clear}>Clear all</Text></TouchableOpacity></View>
            {files.map((file, index) => (
              <View style={styles.fileRow} key={`${file.uri}-${index}`}>
                <View style={styles.fileIcon}><Feather name={file.kind === "video" ? "film" : "music"} size={18} color={theme.COLORS.primary} /></View>
                <View style={{ flex: 1 }}><Text numberOfLines={1} style={styles.fileName}>{file.name}</Text>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Change ${file.name} from ${file.kind} to ${file.kind === "audio" ? "video" : "audio"}`}
                    disabled={isLoading} onPress={() => void changeKind(file)} style={styles.kindControl}>
                    <Text style={styles.fileType}>{file.kind.toUpperCase()} · Change type · {index + 1} / {files.length}</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} disabled={isLoading} onPress={() => setFiles((items) => items.filter((_, i) => i !== index))} style={styles.remove}><Feather name="x" size={18} color={theme.COLORS.subtext} /></TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={styles.addMore} onPress={handleImportFiles} disabled={isLoading || files.length >= MAX_BATCH_FILES}>
              <Feather name="plus" size={16} color={theme.COLORS.primary} /><Text style={styles.addMoreText}>Add more files</Text>
            </TouchableOpacity>
            {files.length === 1 && !isLoading && <View style={styles.preview}>
              <Text style={styles.previewLabel}>PREVIEW</Text>
              {files[0].kind === "video" ? <VideoPlayer uri={files[0].uri} name={files[0].name} /> : <AudioPlayer uri={files[0].uri} name={files[0].name} />}
            </View>}
          </View>
        )}
        {isLoading && <View style={styles.loading}><Host matchContents colorScheme="dark"><LoadingIndicator color={theme.COLORS.primary} /></Host><Text style={styles.loadingText}>{loadingLabel}</Text></View>}
      </ScrollView>
      {!!files.length && <View style={styles.footer}><TouchableOpacity style={[theme.Styles.button, isLoading && theme.Styles.disabledButton]} onPress={proceed} disabled={isLoading}>
        <Text style={theme.Styles.buttonText}>{files.length === 1 ? "Continue" : `Continue with ${files.length} files`}</Text><Feather name="arrow-right" size={20} color={theme.COLORS.background} style={{ marginLeft: 8 }} />
      </TouchableOpacity></View>}
      <SettingsSidebar visible={settingsVisible} onClose={() => setSettingsVisible(false)} />
      <ErrorModal visible={isErrorModalVisible} error={error} onClose={() => setIsErrorModalVisible(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, paddingBottom: 130 },
  header: { marginTop: 26, marginBottom: 28 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  logo: { width: 52, height: 52 }, brandText: { flex: 1 },
  eyebrow: { color: theme.COLORS.primary, fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginBottom: 4 },
  title: { color: theme.COLORS.text, fontSize: 27, fontWeight: "800", letterSpacing: -0.8 },
  subtitle: { color: theme.COLORS.subtext, marginTop: 15, fontSize: 15 },
  settings: { width: 43, height: 43, backgroundColor: theme.COLORS.surface, borderRadius: 14, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.COLORS.border },
  actions: { gap: 14 },
  heroCard: { backgroundColor: "#153044", borderRadius: 24, padding: 22, borderWidth: 1, borderColor: "#24516A", gap: 10 },
  heroTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 },
  heroIcon: { width: 52, height: 52, borderRadius: 16, backgroundColor: "rgba(0,229,255,0.12)", alignItems: "center", justifyContent: "center" },
  heroTitle: { color: theme.COLORS.text, fontSize: 22, fontWeight: "800" },
  heroSubtitle: { color: "#B7CFDA", fontSize: 14, lineHeight: 21 },
  tagRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  tag: { color: theme.COLORS.primary, fontSize: 10, fontWeight: "800", letterSpacing: 0.6, backgroundColor: "rgba(0,229,255,0.1)", paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8 },
  recordCard: { backgroundColor: theme.COLORS.surface, borderRadius: 20, padding: 18, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1, borderColor: theme.COLORS.border },
  recordIcon: { width: 48, height: 48, borderRadius: 14, backgroundColor: "rgba(239,68,68,0.12)", alignItems: "center", justifyContent: "center" },
  actionTitle: { color: theme.COLORS.text, fontSize: 16, fontWeight: "800" },
  actionSubtitle: { color: theme.COLORS.subtext, fontSize: 12, marginTop: 4 },
  privacy: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 10 },
  privacyText: { color: theme.COLORS.subtext, fontSize: 12 },
  selection: { gap: 10 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  sectionTitle: { color: theme.COLORS.text, fontSize: 19, fontWeight: "800" }, clear: { color: theme.COLORS.primary, fontSize: 13, fontWeight: "700" },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.COLORS.surface, borderWidth: 1, borderColor: theme.COLORS.border, padding: 12, borderRadius: 16 },
  fileIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: "rgba(0,229,255,0.09)", alignItems: "center", justifyContent: "center" },
  fileName: { color: theme.COLORS.text, fontSize: 14, fontWeight: "700" }, fileType: { color: theme.COLORS.subtext, fontSize: 10, fontWeight: "700", marginTop: 4, letterSpacing: 0.6 },
  remove: { padding: 8 },
  addMore: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, padding: 14, borderWidth: 1, borderStyle: "dashed", borderColor: theme.COLORS.border, borderRadius: 14 },
  addMoreText: { color: theme.COLORS.primary, fontWeight: "700", fontSize: 13 },
  preview: { backgroundColor: theme.COLORS.surface, borderRadius: 20, padding: 16, marginTop: 8 }, previewLabel: { color: theme.COLORS.subtext, fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 10 },
  loading: { alignItems: "center", gap: 10, marginTop: 24 }, loadingText: { color: theme.COLORS.subtext, fontSize: 13 },
  footer: { position: "absolute", bottom: 0, left: 0, right: 0, padding: 16, backgroundColor: theme.COLORS.background },
  kindControl: { minHeight: 40, justifyContent: "center" },
  dim: { opacity: 0.55 },
});
