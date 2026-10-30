import Feather from "@expo/vector-icons/Feather";
import * as fs from "expo-file-system";
import React, { useEffect, useRef, useState } from "react";
import { Alert, type StyleProp, StyleSheet, Text, TouchableOpacity, type ViewStyle } from "react-native";
import { savedMediaLocation, saveToDevice } from "@/src/scripts/formatHandler";
import { recordDiagnostic, recordDiagnosticError } from "@/src/scripts/diagnostics";
import * as theme from "@/src/constants/theme";

interface SaveButtonProps {
  file: fs.File | null;
  label?: string;
  savedLabel?: string;
  savingLabel?: string;
  albumName?: string;
  style?: StyleProp<ViewStyle>;
  savedBg?: string;
  onError?: (error: Error) => void;
  beforeSave?: () => void;
}

export default function SaveButton({ file, label = "Save to device", savedLabel = "Saved", savingLabel = "Saving file", albumName, style, savedBg, onError, beforeSave }: SaveButtonProps) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);

  const handleSave = async () => {
    if (!file || saving.current) return;
    saving.current = true; setBusy(true);
    recordDiagnostic("export", "export", "START");
    try {
      beforeSave?.();
      await saveToDevice(file, albumName);
      recordDiagnostic("export", "export", "OK");
      if (!mounted.current) return;
      setSaved(true);
      Alert.alert("Saved to device", `Find your file in ${savedMediaLocation(file, albumName)}. It may take a moment to appear in media apps.`);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      recordDiagnosticError("export", "export", error);
      if (mounted.current) {
        const reason = error instanceof Error ? error : new Error(String(error));
        if (onError) onError(reason); else Alert.alert("Could not save", reason.message);
      }
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };

  return <TouchableOpacity accessibilityRole="button" accessibilityLabel={busy ? savingLabel : saved ? savedLabel : label}
    accessibilityState={{ disabled: !file || busy }} disabled={!file || busy}
    style={[styles.base, style, saved && { backgroundColor: savedBg || theme.COLORS.success }, busy && { opacity: 0.6 }]}
    onPress={() => void handleSave()} activeOpacity={0.7}>
    <Feather name={saved ? "check" : "download"} size={18} color={theme.COLORS.background} />
    <Text style={styles.text}>{busy ? "Saving…" : saved ? savedLabel : label}</Text>
  </TouchableOpacity>;
}

const styles = StyleSheet.create({
  base: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 44 },
  text: { color: theme.COLORS.background, fontWeight: "800", fontSize: 14 },
});
