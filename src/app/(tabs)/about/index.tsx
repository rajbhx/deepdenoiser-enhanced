import SettingsSidebar from "@/src/components/SettingsSidebar";
import * as theme from "@/src/constants/theme";
import Feather from "@expo/vector-icons/Feather";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function AboutScreen() {
  const router = useRouter();
  const [settingsVisible, setSettingsVisible] = useState(false);

  const openSource = () => {
    void Linking.openURL("https://github.com/sayampy/deepdenoiser")
      .catch(() => Alert.alert("Could not open link", "Please try again."));
  };

  return (
    <SafeAreaView style={theme.Styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={styles.iconButton}>
          <Feather name="arrow-left" size={22} color={theme.COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>About</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => setSettingsVisible(true)} style={styles.iconButton}>
          <Feather name="settings" size={21} color={theme.COLORS.text} />
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.identity}>
          <View style={styles.mark}><Feather name="activity" size={25} color={theme.COLORS.primary} /></View>
          <View style={styles.identityText}>
            <Text style={styles.title}>DeepDenoiser</Text>
            <Text style={styles.version}>Version {Constants.expoConfig?.version ?? "unknown"}</Text>
          </View>
        </View>

        <Text style={styles.description}>Speech-focused noise reduction for audio and video, processed on your device. Results depend on the recording.</Text>
        <Text style={styles.privacy}>Files you save elsewhere, share, or include in an Android backup or device transfer may leave the app.</Text>

        <View style={styles.links}>
          <TouchableOpacity accessibilityRole="button" onPress={openSource} style={styles.link}>
            <Feather name="github" size={20} color={theme.COLORS.primary} />
            <Text style={styles.linkText}>GitHub repository</Text>
            <Feather name="external-link" size={17} color={theme.COLORS.subtext} />
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" onPress={() => router.push("/about/licenses")} style={styles.link}>
            <Feather name="file-text" size={20} color={theme.COLORS.primary} />
            <Text style={styles.linkText}>Open-source licenses</Text>
            <Feather name="chevron-right" size={19} color={theme.COLORS.subtext} />
          </TouchableOpacity>
        </View>
        <Text style={styles.credit}>Made by Sayampy</Text>
      </ScrollView>
      <SettingsSidebar visible={settingsVisible} onClose={() => setSettingsVisible(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", marginTop: 8, marginBottom: 20 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: theme.COLORS.text, fontSize: 19, fontWeight: "700", marginLeft: 4 },
  content: { paddingBottom: 32 },
  identity: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 14, marginBottom: 28 },
  mark: { width: 54, height: 54, borderRadius: 16, backgroundColor: "rgba(0,229,255,0.1)", alignItems: "center", justifyContent: "center" },
  identityText: { flex: 1 },
  title: { color: theme.COLORS.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  version: { color: theme.COLORS.subtext, fontSize: 13, marginTop: 4 },
  description: { color: theme.COLORS.text, fontSize: 15, lineHeight: 23 },
  privacy: { color: theme.COLORS.subtext, fontSize: 13, lineHeight: 20, marginTop: 14 },
  links: { marginTop: 30, borderTopWidth: 1, borderTopColor: theme.COLORS.border },
  link: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 14, borderBottomWidth: 1, borderBottomColor: theme.COLORS.border },
  linkText: { flex: 1, color: theme.COLORS.text, fontSize: 15, fontWeight: "600" },
  credit: { color: theme.COLORS.subtext, fontSize: 12, marginTop: 28 },
});
