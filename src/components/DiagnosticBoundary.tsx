import React from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as theme from "@/src/constants/theme";
import { isProcessingMedia } from "@/src/scripts/denoiserSingleton";
import { recordDiagnosticError } from "@/src/scripts/diagnostics";
import { assertNativeRecorderIdle } from "@/src/scripts/recordingSafety";

type State = { failed: boolean };

/** Catches React render errors only; native crashes and all asynchronous failures are not covered. */
export default class DiagnosticBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(error: Error): void { recordDiagnosticError("ui", "general", error); }
  private retry = () => {
    try {
      if (isProcessingMedia()) throw new Error("busy");
      assertNativeRecorderIdle();
      this.setState({ failed: false });
    } catch {
      Alert.alert("An operation may still be active", "Do not restart the screen while recording or processing may still be running. Check your originals in Your files when it is safe.");
    }
  };
  render() {
    if (!this.state.failed) return this.props.children;
    return <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="alert">A screen could not be displayed</Text>
      <Text style={styles.message}>Diagnostic events contain no media. If an operation was interrupted, check Your files for the original before retrying. Native crashes may not be captured.</Text>
      <TouchableOpacity accessibilityRole="button" onPress={this.retry} style={styles.button}><Text style={styles.buttonText}>Try again when idle</Text></TouchableOpacity>
    </View>;
  }
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.COLORS.background, justifyContent: "center", padding: 24 },
  title: { color: theme.COLORS.text, fontSize: 22, fontWeight: "700", marginBottom: 12 },
  message: { color: theme.COLORS.subtext, fontSize: 15, lineHeight: 23 },
  button: { minHeight: 48, justifyContent: "center", alignItems: "center", marginTop: 24, backgroundColor: theme.COLORS.primary, borderRadius: 12 },
  buttonText: { color: theme.COLORS.background, fontWeight: "700" },
});
