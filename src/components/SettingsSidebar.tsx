import * as theme from "@/src/constants/theme";
import { Feather } from "@expo/vector-icons";
import Constants from "expo-constants";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  AppSettings,
  AttenPreset,
  CoreMode,
  RuntimeMode,
  getSettings,
  resolveCoreLevel,
  updateSettings,
} from "../scripts/settings";
import { getEngineLabel, resetDenoiser } from "../scripts/denoiserSingleton";

interface SettingsSidebarProps {
  visible: boolean;
  onClose: () => void;
}

export default function SettingsSidebar({ visible, onClose }: SettingsSidebarProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [engine, setEngine] = useState("not-loaded");

  const loadSettings = async () => {
    const s = await getSettings();
    setSettings(s);
    setEngine(getEngineLabel());
  };

  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadSettings();
    }
  }, [visible]);

  const saveSettings = async (patch: Partial<AppSettings>): Promise<AppSettings | null> => {
    try { return await updateSettings(patch); }
    catch (error) {
      Alert.alert("Settings not saved", error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  if (!settings) return null;

  const effectiveCores = resolveCoreLevel(settings);

  return (
    <Modal
      animationType="none"
      transparent={true}
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <Pressable style={styles.overlay} onPress={onClose} />
        <View style={styles.sidebar}>
          <View style={styles.header}>
            <Text style={styles.title}>Settings</Text>
            <TouchableOpacity onPress={onClose}>
              <Feather name="x" size={24} color={theme.COLORS.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Denoise</Text>

            <View style={styles.settingItem}>
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingLabel}>Strength preset</Text>
                <Text style={styles.settingDescription}>
                  Max = strongest noise cut (0 dB). Light keeps more room tone.
                </Text>
                <View style={styles.coreRow}>
                  {(
                    [
                      ["max", "Max"],
                      ["strong", "Strong"],
                      ["medium", "Med"],
                      ["light", "Light"],
                    ] as [Exclude<AttenPreset, "custom">, string][]
                  ).map(([id, label]) => {
                    const selected = settings.attenPreset === id;
                    return (
                      <TouchableOpacity
                        key={id}
                        style={[styles.coreChip, selected && styles.coreChipOn]}
                        onPress={async () => {
                          const updated = await saveSettings({ attenPreset: id });
                          if (updated) setSettings(updated);
                        }}
                      >
                        <Text style={[styles.coreChipText, selected && styles.coreChipTextOn]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </View>

            <View style={styles.settingItem}>
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingLabel}>Runtime</Text>
                <Text style={styles.settingDescription}>
                  Auto/XNNPACK = best on OnePlus 7. GPU = NNAPI GPU try (not OpenCL). Attempted provider: {engine}
                </Text>
                <View style={styles.coreRow}>
                  {(
                    [
                      ["auto", "Auto"],
                      ["xnnpack", "XNNPACK"],
                      ["gpu", "GPU"],
                      ["nnapi", "NNAPI"],
                      ["cpu", "CPU"],
                    ] as [RuntimeMode, string][]
                  ).map(([id, label]) => {
                    const selected = settings.runtime === id;
                    return (
                      <TouchableOpacity
                        key={id}
                        style={[styles.coreChip, selected && styles.coreChipOn]}
                        onPress={async () => {
                          if (id === settings.runtime) return;
                          const updated = await saveSettings({ runtime: id });
                          if (!updated) return;
                          setSettings(updated);
                          await resetDenoiser();
                          setEngine("not-loaded");
                        }}
                      >
                        <Text style={[styles.coreChipText, selected && styles.coreChipTextOn]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </View>

            <View style={styles.settingItem}>
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingLabel}>Core level</Text>
                <Text style={styles.settingDescription}>
                  Auto picks from device (now {effectiveCores} threads). Manual 2/4/8 overrides.
                </Text>
                <View style={styles.coreRow}>
                  {(
                    [
                      ["auto", "Auto"],
                      [2, "2"],
                      [4, "4"],
                      [8, "8"],
                    ] as [CoreMode, string][]
                  ).map(([id, label]) => {
                    const selected = settings.coreMode === id;
                    return (
                      <TouchableOpacity
                        key={String(id)}
                        style={[styles.coreChip, selected && styles.coreChipOn]}
                        onPress={async () => {
                          if (id === settings.coreMode) return;
                          const patch =
                            id === "auto"
                              ? { coreMode: "auto" as const }
                              : { coreMode: id as 2 | 4 | 8, coreLevel: id as 2 | 4 | 8 };
                          const updated = await saveSettings(patch);
                          if (!updated) return;
                          setSettings(updated);
                          await resetDenoiser();
                          setEngine("not-loaded");
                        }}
                      >
                        <Text style={[styles.coreChipText, selected && styles.coreChipTextOn]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </View>
          </View>


          <View style={styles.footer}>
            <Text style={styles.version}>Version {Constants.expoConfig?.version}</Text>
            <Text style={styles.note}>Privacy-first · Offline · OnePlus 7 tuned</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: "row",
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sidebar: {
    width: 300,
    backgroundColor: theme.COLORS.background,
    borderLeftWidth: 1,
    borderLeftColor: theme.COLORS.border,
    paddingTop: 48,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 32,
  },
  title: {
    fontSize: theme.FONT_SIZE.heading,
    fontWeight: "700",
    color: theme.COLORS.text,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.COLORS.subtext,
    marginBottom: 16,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  settingItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  settingTextContainer: {
    flex: 1,
    marginRight: 12,
  },
  settingLabel: {
    fontSize: theme.FONT_SIZE.body,
    fontWeight: "600",
    color: theme.COLORS.text,
    marginBottom: 4,
  },
  settingDescription: {
    fontSize: 12,
    color: theme.COLORS.subtext,
    lineHeight: 16,
  },
  coreRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 10,
  },
  coreChip: {
    minWidth: 44,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginRight: 8,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.COLORS.border,
    alignItems: "center",
  },
  coreChipOn: {
    backgroundColor: theme.COLORS.primary,
    borderColor: theme.COLORS.primary,
  },
  coreChipText: {
    color: theme.COLORS.text,
    fontWeight: "600",
    fontSize: 12,
  },
  coreChipTextOn: {
    color: theme.COLORS.white,
  },
  footer: {
    marginTop: "auto",
    paddingBottom: 40,
  },
  version: {
    fontSize: 12,
    color: theme.COLORS.subtext,
    textAlign: "center",
  },
  note: {
    fontSize: 11,
    color: theme.COLORS.subtext,
    textAlign: "center",
    marginTop: 6,
    opacity: 0.7,
  },
});
