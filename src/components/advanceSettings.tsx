import * as theme from "@/src/constants/theme";
import type { SilenceTrimSettings } from "@/src/scripts/silenceTrim";
import Feather from "@expo/vector-icons/Feather";
import React, { useState } from "react";
import {
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ATTEN_PRESET_DB, type AttenPreset } from "@/src/scripts/settings";
import CustomSlider from "./customSlider";
import InfoBubble from "./InfoBubble";
import SilenceTrimSettingsBlock from "./silenceTrimSettings";

interface AdvanceSettingsProps {
  attenLimDb: number;
  onAttenLimDbChange: (value: number) => void;
  normalize: {
    toggle: boolean;
    targetRMS: number;
    maxPeakDb: number;
  };
  onNormalizeChange: (value: any) => void;
  silenceTrim: SilenceTrimSettings;
  onSilenceTrimChange: (value: SilenceTrimSettings) => void;
  /** Hide the silence-trim section entirely (e.g. video files). */
  showSilenceTrim?: boolean;
}

const ALSTEPS = [0, 5, 10, 15, 20, 30, 40];

export default function AdvanceSettings({
  attenLimDb,
  onAttenLimDbChange,
  normalize,
  onNormalizeChange,
  silenceTrim,
  onSilenceTrimChange,
  showSilenceTrim = true,
}: AdvanceSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleToggleNormalize = () => {
    onNormalizeChange({
      ...normalize,
      toggle: !normalize.toggle,
    });
  };

  const handleTargetRMSChange = (val: number) => {
    onNormalizeChange({
      ...normalize,
      targetRMS: val,
    });
  };

  const handleMaxPeakChange = (val: number) => {
    onNormalizeChange({
      ...normalize,
      maxPeakDb: val,
    });
  };

  const presetFromDb = (): AttenPreset => {
    for (const [k, v] of Object.entries(ATTEN_PRESET_DB) as [Exclude<AttenPreset,"custom">, number][]) {
      if (v === attenLimDb) return k;
    }
    return "custom";
  };
  const activePreset = presetFromDb();

  return (
    <View style={styles.container}>
      <Text style={styles.presetTitle}>Strength</Text>
      <View style={styles.presetRow}>
        {([
          ["max", "Max"],
          ["strong", "Strong"],
          ["medium", "Med"],
          ["light", "Light"],
        ] as [Exclude<AttenPreset, "custom">, string][]).map(([id, label]) => {
          const on = activePreset === id;
          return (
            <TouchableOpacity
              key={id}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.presetChip, on && styles.presetChipOn]}
              onPress={() => onAttenLimDbChange(ATTEN_PRESET_DB[id])}
            >
              <Text style={[styles.presetChipText, on && styles.presetChipTextOn]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <TouchableOpacity
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        onPress={() => setIsOpen(!isOpen)}
        activeOpacity={0.7}
      >
        <View style={theme.Styles.row}>
          <Feather
            name="settings"
            size={18}
            color={theme.COLORS.primary}
            style={{ marginRight: 8 }}
          />
          <Text style={styles.headerText}>Advanced Settings</Text>
        </View>
        <Feather
          name={isOpen ? "chevron-up" : "chevron-down"}
          size={20}
          color={theme.COLORS.subtext}
        />
      </TouchableOpacity>

      {isOpen && (
        <View style={styles.content}>
          <View style={[styles.settingItem, { marginBottom: 10 }]}>
            <View style={styles.settingLabelRow}>
              <View style={theme.Styles.row}>
                <Text style={styles.settingLabel}>Loudness Normalization</Text>
                <InfoBubble text={`Applies a capped gain before denoising. The model can change loudness or peaks, so the final output is not guaranteed to meet the targets. Listen to the result.`}>
                  <Feather name="help-circle" size={18} color={theme.COLORS.subtext} />
                </InfoBubble>
              </View>
              <Switch accessibilityLabel="Loudness normalization" value={normalize.toggle}
                onValueChange={handleToggleNormalize} trackColor={{ false: theme.COLORS.border, true: theme.COLORS.primary }}
                thumbColor={normalize.toggle ? theme.COLORS.background : theme.COLORS.text} />
            </View>
          </View>

          {normalize.toggle && (
            <View>
              <CustomSlider
                label="Target RMS"
                value={normalize.targetRMS}
                onValueChange={handleTargetRMSChange}
                min={-20}
                max={-10}
                decimalPlaces={0}
                info={`Target for gain applied before denoising. Gain is capped to protect peaks and limit amplification. The output loudness can differ after the model.`}
              />
              <CustomSlider
                label="Input peak target"
                value={normalize.maxPeakDb}
                onValueChange={handleMaxPeakChange}
                min={-10}
                max={0}
                decimalPlaces={0}
                info={`Limits the gain applied to the input before denoising. This is not a hard limiter on model output; listen and check the final result.`}
              />
            </View>
          )}

          <View style={{ height: 1, backgroundColor: "rgba(255, 255, 255, 0.05)", marginVertical: 15 }} />

          <CustomSlider
            label="Clean/original mix (dB)"
            value={attenLimDb}
            onValueChange={onAttenLimDbChange}
            min={0}
            max={40}
            steps={ALSTEPS}
            info={`Blends the cleaned and time-aligned original audio.\n0 dB = 100% cleaned; 20 dB ≈ 10% cleaned; 40 dB ≈ 1% cleaned.\nThis is a mix control, not a measured or guaranteed noise-reduction level.`}
          />

          {showSilenceTrim && (
            <>
              <View style={{ height: 1, backgroundColor: "rgba(255, 255, 255, 0.05)", marginVertical: 15 }} />
              <SilenceTrimSettingsBlock
                settings={silenceTrim}
                onChange={onSilenceTrimChange}
              />
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  presetTitle: {
    color: theme.COLORS.subtext,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 8,
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 14,
  },
  presetChip: {
    minHeight: 44,
    justifyContent: "center",
    marginBottom: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginRight: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.COLORS.border,
  },
  presetChipOn: {
    backgroundColor: theme.COLORS.primary,
    borderColor: theme.COLORS.primary,
  },
  presetChipText: {
    color: theme.COLORS.text,
    fontWeight: "600",
    fontSize: 12,
  },
  presetChipTextOn: {
    color: theme.COLORS.background,
  },

  container: {
    backgroundColor: theme.COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.COLORS.border,
    marginTop: 16,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.SPACING.medium,
  },
  headerText: {
    color: theme.COLORS.text,
    fontSize: theme.FONT_SIZE.body,
    fontWeight: "600",
  },
  content: {
    paddingHorizontal: theme.SPACING.medium,
    paddingBottom: theme.SPACING.medium,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.05)",
  },
  settingItem: {
    marginTop: theme.SPACING.small,
  },
  settingLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  settingLabel: {
    color: theme.COLORS.subtext,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
