import * as theme from "@/src/constants/theme";
import { claimSharedBatch, finishSharedBatch } from "@/src/scripts/shareClaim";
import { importSharedMedia } from "@/src/scripts/sharedImport";
import { isCurrentShare, useRawIncomingShare } from "@/src/scripts/useRawIncomingShare";
import { useProcessingBusy } from "@/src/scripts/useProcessingBusy";
import { recordDiagnostic, recordDiagnosticError } from "@/src/scripts/diagnostics";
import { Host, LoadingIndicator } from "@expo/ui/jetpack-compose";
import { useIsFocused, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";

export default function ShareHandler() {
  const { payloads, generation, consume, discardUnreadable, error: shareError } = useRawIncomingShare();
  const router = useRouter();
  const focused = useIsFocused();
  const processingBusy = useProcessingBusy();
  const navigatingFromShare = useRef(false);
  useEffect(() => { if (focused) navigatingFromShare.current = false; }, [focused]);
  const [label, setLabel] = useState("Preparing shared media…");
  const reportedShareError = useRef<Error | null>(null);

  useEffect(() => {
    if (!focused || processingBusy || navigatingFromShare.current) return;
    if (shareError) {
      if (reportedShareError.current !== shareError) {
        reportedShareError.current = shareError;
        recordDiagnosticError("share", "share", shareError);
        Alert.alert("Could not read shared media", `${shareError.message}\nPlease share the files again.`, [
          { text: "Dismiss", onPress: () => { discardUnreadable(); router.navigate("/(tabs)"); } },
        ]);
      }
      return;
    }
    reportedShareError.current = null;
    if (!payloads.length || !isCurrentShare(payloads, generation)) return;
    const claim = claimSharedBatch([generation]);
    if (!claim) return;
    void (async () => {
      try {
        recordDiagnostic("share", "share", "START");
        let damagedImport = false;
        const selection = await importSharedMedia(payloads,
          (current, total) => setLabel(`Importing shared file ${current} of ${total}…`),
          () => { damagedImport = true; });
        if (damagedImport) Alert.alert("Older import failed verification", "An older private copy could not be verified and was not overwritten. A separate verified copy was selected. Check Your files for both copies.");
        navigatingFromShare.current = true;
        recordDiagnostic("share", "share", "OK");
        consume(payloads, generation);
        router.replace({ pathname: "/processing/process", params: {
          fileuri: encodeURIComponent(selection[0].uri),
          filename: encodeURIComponent(selection[0].name),
          batch: encodeURIComponent(JSON.stringify(selection)),
        } });
      } catch (error) {
        recordDiagnosticError("share", "share", error);
        navigatingFromShare.current = false;
        consume(payloads, generation);
        const message = error instanceof Error ? error.message : String(error);
        Alert.alert("Could not import shared media", message, [{ text: "OK", onPress: () => router.navigate("/(tabs)") }]);
      } finally { finishSharedBatch(claim); }
    })();
  }, [payloads, generation, shareError, consume, discardUnreadable, router, focused, processingBusy]);

  return <View style={[theme.Styles.container, styles.centered]}>
    <Host matchContents colorScheme="dark"><LoadingIndicator color={theme.COLORS.primary} /></Host>
    <Text accessibilityLiveRegion="polite" style={styles.loadingText}>{processingBusy
      ? "Shared files are waiting. Finish the current recording or processing first."
      : label}</Text>
    {(processingBusy || !payloads.length) && <TouchableOpacity accessibilityRole="button" style={styles.home} onPress={() => {
      if (router.canGoBack()) router.back(); else router.navigate("/(tabs)");
    }}>
      <Text style={styles.homeText}>Go back</Text>
    </TouchableOpacity>}
  </View>;
}

const styles = StyleSheet.create({
  centered: { justifyContent: "center", alignItems: "center", padding: 20 },
  loadingText: { marginTop: 20, fontSize: theme.FONT_SIZE.body, color: theme.COLORS.text, textAlign: "center" },
  home: { minHeight: 44, justifyContent: "center", marginTop: 20 }, homeText: { color: theme.COLORS.primary, fontWeight: "700" },
});
