import * as theme from "@/src/constants/theme";
import { Feather } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type AppSettings, type AttenPreset, type CoreMode, type RuntimeMode, getSettings, resolveCoreLevel, updateSettings } from "../scripts/settings";
import { getEngineLabel, resetDenoiser } from "../scripts/denoiserSingleton";

interface SettingsSidebarProps { visible: boolean; onClose: () => void }

export default function SettingsSidebar({ visible, onClose }: SettingsSidebarProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [engine, setEngine] = useState("not-loaded");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const settingsVersion = useRef(0);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const loadedVersion = settingsVersion.current;
    void getSettings().then(value => {
      if (active && loadedVersion === settingsVersion.current) { setSettings(value); setEngine(getEngineLabel()); }
    }).catch(error => {
      if (active) Alert.alert("Could not load settings", error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible]);

  const close = () => { setLoading(true); onClose(); };
  const apply = async (patch: Partial<AppSettings>, reset = false) => {
    if (saveLock.current || loading) return;
    saveLock.current = true; settingsVersion.current++; setSaving(true);
    let saved = false;
    try {
      const updated = await updateSettings(patch);
      settingsVersion.current++;
      saved = true; setSettings(updated);
      if (reset) { await resetDenoiser(); setEngine("not-loaded"); }
    } catch (error) {
      Alert.alert(saved ? "Settings saved; restart may be needed" : "Settings not saved", error instanceof Error ? error.message : String(error));
    } finally { saveLock.current = false; setSaving(false); }
  };
  const disabled = saving || loading || !settings;

  return <Modal animationType="none" transparent visible={visible} onRequestClose={close}>
    <View style={styles.container}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close settings" style={styles.overlay} onPress={close} />
      <ScrollView accessibilityViewIsModal style={styles.sidebar}
        contentContainerStyle={[styles.sidebarContent, { paddingTop: Math.max(20, insets.top + 12), paddingBottom: Math.max(24, insets.bottom + 16) }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Settings</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close settings" onPress={close} style={styles.close}>
            <Feather name="x" size={24} color={theme.COLORS.text} />
          </TouchableOpacity>
        </View>
        {loading || !settings ? <Text accessibilityLiveRegion="polite" style={styles.description}>Loading settings…</Text> : <>
          <Text style={styles.sectionTitle}>Denoise</Text>
          <View style={styles.settingItem}>
            <Text style={styles.settingLabel}>Strength preset</Text>
            <Text style={styles.description}>Max uses the cleaned signal; lighter settings blend in more of the original. Reduction varies with the recording.</Text>
            <View style={styles.coreRow}>
              {([ ["max", "Max"], ["strong", "Strong"], ["medium", "Med"], ["light", "Light"] ] as [Exclude<AttenPreset, "custom">, string][]).map(([id, label]) => {
                const selected = settings.attenPreset === id;
                return <TouchableOpacity key={id} accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled}
                  style={[styles.coreChip, selected && styles.coreChipOn, disabled && styles.disabled]} onPress={() => void apply({ attenPreset: id })}>
                  <Text style={[styles.coreChipText, selected && styles.coreChipTextOn]}>{label}</Text>
                </TouchableOpacity>;
              })}
            </View>
          </View>
          <View style={styles.settingItem}>
            <Text style={styles.settingLabel}>Runtime</Text>
            <Text style={styles.description}>Auto/XNNPACK are options to try. GPU attempts NNAPI, not OpenCL; the label does not prove which hardware ran inference. Attempted provider: {engine}</Text>
            <View style={styles.coreRow}>
              {([ ["auto", "Auto"], ["xnnpack", "XNNPACK"], ["gpu", "GPU"], ["nnapi", "NNAPI"], ["cpu", "CPU"] ] as [RuntimeMode, string][]).map(([id, label]) => {
                const selected = settings.runtime === id;
                return <TouchableOpacity key={id} accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled}
                  style={[styles.coreChip, selected && styles.coreChipOn, disabled && styles.disabled]}
                  onPress={() => { if (!selected) void apply({ runtime: id }, true); }}>
                  <Text style={[styles.coreChipText, selected && styles.coreChipTextOn]}>{label}</Text>
                </TouchableOpacity>;
              })}
            </View>
          </View>
          <View style={styles.settingItem}>
            <Text style={styles.settingLabel}>Core level</Text>
            <Text style={styles.description}>Auto picks from device (now {resolveCoreLevel(settings)} threads). Manual 2/4/8 overrides.</Text>
            <View style={styles.coreRow}>
              {([ ["auto", "Auto"], [2, "2"], [4, "4"], [8, "8"] ] as [CoreMode, string][]).map(([id, label]) => {
                const selected = settings.coreMode === id;
                return <TouchableOpacity key={String(id)} accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled}
                  style={[styles.coreChip, selected && styles.coreChipOn, disabled && styles.disabled]}
                  onPress={() => { if (!selected) void apply(id === "auto" ? { coreMode: "auto" } : { coreMode: id, coreLevel: id }, true); }}>
                  <Text style={[styles.coreChipText, selected && styles.coreChipTextOn]}>{label}</Text>
                </TouchableOpacity>;
              })}
            </View>
          </View>
          {saving && <Text accessibilityLiveRegion="polite" style={styles.description}>Saving settings…</Text>}
        </>}
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open diagnostics" style={styles.about} onPress={() => { close(); router.push("/diagnostics"); }}>
          <Feather name="activity" size={19} color={theme.COLORS.primary} /><Text style={styles.aboutText}>Diagnostics &amp; self-check</Text>
          <Feather name="chevron-right" size={18} color={theme.COLORS.subtext} />
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={styles.about} onPress={() => { close(); router.push("/about"); }}>
          <Feather name="info" size={19} color={theme.COLORS.primary} /><Text style={styles.aboutText}>About DeepDenoiser</Text>
          <Feather name="chevron-right" size={18} color={theme.COLORS.subtext} />
        </TouchableOpacity>
        <View style={styles.footer}>
          <Text style={styles.version}>Version {Constants.expoConfig?.version}</Text>
          <Text style={styles.note}>Privacy-first · Offline · OnePlus 7 tuned</Text>
        </View>
      </ScrollView>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: "row" }, overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sidebar: { width: "88%", maxWidth: 360, backgroundColor: theme.COLORS.background, borderLeftWidth: 1, borderLeftColor: theme.COLORS.border },
  sidebarContent: { paddingHorizontal: 20, flexGrow: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 24 },
  close: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  title: { fontSize: theme.FONT_SIZE.heading, fontWeight: "700", color: theme.COLORS.text },
  sectionTitle: { fontSize: 13, fontWeight: "600", color: theme.COLORS.subtext, marginBottom: 16, textTransform: "uppercase", letterSpacing: 0.5 },
  settingItem: { marginBottom: 20 }, settingLabel: { fontSize: theme.FONT_SIZE.body, fontWeight: "600", color: theme.COLORS.text, marginBottom: 4 },
  description: { fontSize: 12, color: theme.COLORS.subtext, lineHeight: 18 }, coreRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 10 },
  coreChip: { minWidth: 44, minHeight: 44, justifyContent: "center", paddingHorizontal: 10, marginRight: 8, marginBottom: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.COLORS.border, alignItems: "center" },
  coreChipOn: { backgroundColor: theme.COLORS.primary, borderColor: theme.COLORS.primary },
  coreChipText: { color: theme.COLORS.text, fontWeight: "600", fontSize: 12 }, coreChipTextOn: { color: theme.COLORS.background }, disabled: { opacity: 0.6 },
  about: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: 10, borderTopWidth: 1, borderTopColor: theme.COLORS.border, marginTop: 12 },
  aboutText: { flex: 1, color: theme.COLORS.primary, fontSize: 14, fontWeight: "700" },
  footer: { marginTop: "auto", paddingTop: 24 }, version: { fontSize: 12, color: theme.COLORS.subtext, textAlign: "center" },
  note: { fontSize: 11, color: theme.COLORS.subtext, textAlign: "center", marginTop: 6 },
});
