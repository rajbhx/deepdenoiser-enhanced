import licensesData from "@/assets/generated/licenses.json";
import * as theme from "@/src/constants/theme";
import Feather from "@expo/vector-icons/Feather";
import { Host, OutlinedTextField } from "@expo/ui/jetpack-compose";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Notice { file: string; text: string }
interface LicenseInfo { licenses: string; repository?: string; notices: Notice[] }
type LicenseItem = LicenseInfo & { name: string };
const allLicenses: LicenseItem[] = Object.entries(licensesData as Record<string, LicenseInfo>)
  .map(([name, info]) => ({ name, ...info }));
const PAGE_SIZE = 12000;

function LicenseCard({ item }: { item: LicenseItem }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const notice = selected === null ? null : item.notices[selected];
  const pageCount = notice ? Math.max(1, Math.ceil(notice.text.length / PAGE_SIZE)) : 0;
  return <View style={[theme.Styles.card, styles.licenseCard]}>
    <Text style={styles.packageName}>{item.name}</Text>
    <View style={styles.licenseDetails}>
      <Text style={styles.badgeText}>{item.licenses}</Text>
      {!!item.repository && <TouchableOpacity accessibilityRole="link" onPress={() => void Linking.openURL(item.repository!)} style={styles.repoLink}>
        <Feather name="external-link" size={14} color={theme.COLORS.primary} /><Text style={styles.linkText}>Source</Text>
      </TouchableOpacity>}
    </View>
    {!item.notices.length && <Text style={styles.missing}>No local license text found; review before distribution.</Text>}
    {item.notices.map((entry, index) => <TouchableOpacity key={`${entry.file}-${index}`} accessibilityRole="button"
      accessibilityState={{ expanded: selected === index }} style={styles.noticeButton}
      onPress={() => { setSelected(selected === index ? null : index); setPage(0); }}>
      <Text style={styles.linkText}>{selected === index ? "Hide" : "Read"}: {entry.file}</Text>
    </TouchableOpacity>)}
    {!!notice && <View style={styles.notice}>
      <Text selectable style={styles.noticeText}>{notice.text.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)}</Text>
      {pageCount > 1 && <View style={styles.pageRow}>
        <TouchableOpacity accessibilityRole="button" disabled={page === 0} onPress={() => setPage(page - 1)}><Text style={page === 0 ? styles.missing : styles.linkText}>Previous</Text></TouchableOpacity>
        <Text style={styles.missing}>Page {page + 1} of {pageCount}</Text>
        <TouchableOpacity accessibilityRole="button" disabled={page + 1 >= pageCount} onPress={() => setPage(page + 1)}><Text style={page + 1 >= pageCount ? styles.missing : styles.linkText}>Next</Text></TouchableOpacity>
      </View>}
    </View>}
  </View>;
}

export default function LicensesScreen() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const filtered = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return allLicenses.filter(item => item.name.toLowerCase().includes(query) || item.licenses.toLowerCase().includes(query));
  }, [searchQuery]);
  return <SafeAreaView style={theme.Styles.container} edges={["top", "left", "right"]}>
    <View style={styles.header}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={styles.backButton}><Feather name="arrow-left" size={24} color={theme.COLORS.text} /></TouchableOpacity>
      <Text style={theme.Styles.title}>Licenses</Text>
    </View>
    <Text style={styles.explanation}>This inventory covers the resolved npm dependency graph, including some build tools. It is not a complete Android/native or model license review. Missing notices require review before distribution.</Text>
    <View style={styles.searchContainer}>
      <Host style={{ flex: 1 }} colorScheme="dark"><OutlinedTextField singleLine onValueChange={setSearchQuery} keyboardOptions={{ imeAction: "search" }}
        colors={{ focusedContainerColor: theme.COLORS.surface, unfocusedContainerColor: theme.COLORS.surface, focusedTextColor: theme.COLORS.text, unfocusedTextColor: theme.COLORS.text, focusedIndicatorColor: theme.COLORS.primary, unfocusedIndicatorColor: theme.COLORS.border, focusedPlaceholderColor: theme.COLORS.subtext, unfocusedPlaceholderColor: theme.COLORS.subtext }}>
        <OutlinedTextField.Placeholder>Search libraries...</OutlinedTextField.Placeholder>
      </OutlinedTextField></Host>
      {!!searchQuery && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setSearchQuery("")}><Feather name="x" size={18} color={theme.COLORS.subtext} /></TouchableOpacity>}
    </View>
    <FlatList data={filtered} renderItem={({ item }) => <LicenseCard item={item} />} keyExtractor={item => item.name}
      contentContainerStyle={styles.listContent} initialNumToRender={10} maxToRenderPerBatch={10} windowSize={7}
      ListEmptyComponent={<Text style={styles.missing}>No matching entries.</Text>} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", marginBottom: theme.SPACING.medium, marginTop: theme.SPACING.small },
  backButton: { padding: 8, marginRight: 8, marginLeft: -8 },
  explanation: { color: theme.COLORS.subtext, fontSize: theme.FONT_SIZE.small, lineHeight: 19, marginBottom: 12 },
  searchContainer: { flexDirection: "row", alignItems: "center", marginBottom: theme.SPACING.medium, height: 56 },
  listContent: { paddingBottom: theme.SPACING.xlarge, gap: theme.SPACING.small },
  licenseCard: { padding: theme.SPACING.medium },
  packageName: { fontSize: theme.FONT_SIZE.body, fontWeight: "700", color: theme.COLORS.text, marginBottom: 8 },
  licenseDetails: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  badgeText: { fontSize: theme.FONT_SIZE.xsmall, color: theme.COLORS.primary, fontWeight: "600", flex: 1 },
  repoLink: { flexDirection: "row", alignItems: "center", gap: 4 },
  linkText: { fontSize: theme.FONT_SIZE.small, color: theme.COLORS.primary, fontWeight: "500" },
  missing: { fontSize: theme.FONT_SIZE.small, color: theme.COLORS.subtext, marginTop: 8 },
  noticeButton: { minHeight: 40, justifyContent: "center" },
  notice: { backgroundColor: theme.COLORS.background, borderRadius: 8, padding: 12, marginTop: 4 },
  noticeText: { color: theme.COLORS.text, fontSize: 12, lineHeight: 18 },
  pageRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
});
