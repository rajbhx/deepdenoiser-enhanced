import Feather from "@expo/vector-icons/Feather";
import * as fs from "expo-file-system";
import React, { useEffect, useRef, useState } from "react";
import { StyleProp, StyleSheet, Text, TouchableOpacity, ViewStyle } from "react-native";
import { saveToDevice } from "@/src/scripts/formatHandler";
import * as theme from "@/src/constants/theme";

interface SaveButtonProps {
  file: fs.File | null;
  label?: string;
  savedLabel?: string;
  albumName?: string;
  style?: StyleProp<ViewStyle>;
  savedBg?: string;
  onError?: (error: Error) => void;
  beforeSave?: () => void;
}

export default function SaveButton({
  file,
  label = "Save to Gallery",
  savedLabel = "Saved",
  albumName,
  style,
  savedBg,
  onError,
  beforeSave,
}: SaveButtonProps) {
  const [saved, setSaved] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);

  const handleSave = async () => {
    if (!file || saving.current) return;
    saving.current = true;
    try {
      beforeSave?.();
      const success = await saveToDevice(file, albumName);
      if (!mounted.current) return;
      if (!success) {
        onError?.(new Error("Could not save the file. Check media permissions and available storage."));
        return;
      }
      setSaved(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      if (mounted.current) onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally { saving.current = false; }
  };

  return (
    <TouchableOpacity
      style={[
        styles.base,
        style,
        saved && { backgroundColor: savedBg || theme.COLORS.success },
      ]}
      onPress={handleSave}
      activeOpacity={0.7}
    >
      <Feather
        name={saved ? "check" : "download"}
        size={18}
        color={saved ? theme.COLORS.white : theme.COLORS.background}
      />
      <Text style={[styles.text, saved && styles.savedText]}>
        {saved ? savedLabel : label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  text: {
    color: theme.COLORS.background,
    fontWeight: "800",
    fontSize: 14,
  },
  savedText: {
    color: theme.COLORS.white,
  },
});
