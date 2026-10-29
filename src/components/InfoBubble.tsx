import * as theme from "@/src/constants/theme";
import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";

interface InfoBubbleProps {
  text: string;
  children: React.ReactNode;
  label?: string;
}

/** A bounded, scrollable help dialog remains visible near every screen edge. */
export default function InfoBubble({ text, children, label = "Show help" }: InfoBubbleProps) {
  const [visible, setVisible] = useState(false);
  const { width, height } = useWindowDimensions();
  const close = () => setVisible(false);
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Opens explanatory help"
      onPress={() => setVisible(true)} hitSlop={14}>{children}</Pressable>
    <Modal transparent visible={visible} animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close help" onPress={close} />
        <View accessibilityViewIsModal style={[styles.bubble, { maxWidth: Math.max(1, Math.min(width - 32, 400)), maxHeight: Math.max(1, height - 80) }]}>
          <ScrollView nestedScrollEnabled><Text style={styles.text}>{text}</Text></ScrollView>
          <Pressable accessibilityRole="button" onPress={close} style={styles.done}><Text style={styles.doneText}>Done</Text></Pressable>
        </View>
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", alignItems: "center", padding: 16 },
  bubble: { width: "100%", backgroundColor: theme.COLORS.surface, padding: 20, borderRadius: 16, borderWidth: 1, borderColor: theme.COLORS.border, elevation: 10 },
  text: { color: theme.COLORS.text, fontSize: theme.FONT_SIZE.small, fontWeight: "500", lineHeight: 22 },
  done: { minHeight: 44, justifyContent: "center", alignItems: "flex-end", paddingHorizontal: 8, marginTop: 8 },
  doneText: { color: theme.COLORS.primary, fontWeight: "800", fontSize: 14 },
});
