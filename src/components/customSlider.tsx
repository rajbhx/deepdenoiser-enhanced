import * as theme from "@/src/constants/theme";
import { adjustedSliderValue, sliderProgress } from "@/src/scripts/sliderMath";
import Feather from "@expo/vector-icons/Feather";
import React, { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import InfoBubble from "./InfoBubble";

export interface CustomSliderProps {
  label: string;
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  steps?: number[];
  unit?: string;
  info?: string;
  decimalPlaces?: number;
}

export default function CustomSlider({ label, value, onValueChange, min, max, steps, unit = "dB", info, decimalPlaces = 0 }: CustomSliderProps) {
  const sliderWidth = useSharedValue(0);
  const isPressed = useSharedValue(false);
  const progress = useSharedValue(0);
  const discrete = steps && steps.length > 1 ? steps : undefined;

  useEffect(() => {
    progress.value = withSpring(sliderProgress(value, min, max, discrete));
  }, [value, discrete, min, max, progress]);

  /* eslint-disable react-hooks/immutability -- shared values are manipulated by gesture worklets */
  const pan = Gesture.Pan()
    .minDistance(5)
    .onBegin(() => { isPressed.value = true; })
    .onUpdate(event => {
      if (sliderWidth.value <= 0) return;
      const position = Math.max(0, Math.min(1, event.x / sliderWidth.value));
      progress.value = position;
      if (!discrete) runOnJS(onValueChange)(Number((min + position * (max - min)).toFixed(decimalPlaces)));
    })
    .onEnd(event => {
      if (sliderWidth.value <= 0) return;
      const position = Math.max(0, Math.min(1, event.x / sliderWidth.value));
      if (discrete) {
        const index = Math.round(position * (discrete.length - 1));
        progress.value = withSpring(index / (discrete.length - 1));
        runOnJS(onValueChange)(discrete[index]);
      } else {
        progress.value = position;
        runOnJS(onValueChange)(Number((min + position * (max - min)).toFixed(decimalPlaces)));
      }
    })
    .onFinalize(() => { isPressed.value = false; });
  const tap = Gesture.Tap().onEnd((event, success) => {
    if (!success || sliderWidth.value <= 0) return;
    const position = Math.max(0, Math.min(1, event.x / sliderWidth.value));
    if (discrete) {
      const index = Math.round(position * (discrete.length - 1));
      progress.value = withSpring(index / (discrete.length - 1));
      runOnJS(onValueChange)(discrete[index]);
    } else {
      progress.value = position;
      runOnJS(onValueChange)(Number((min + position * (max - min)).toFixed(decimalPlaces)));
    }
  });
  /* eslint-enable react-hooks/immutability */

  const thumbStyle = useAnimatedStyle(() => ({
    left: `${progress.value * 100}%`,
    transform: [{ translateX: -10 }, { scale: withSpring(isPressed.value ? 1.3 : 1) }],
  }));
  const fillStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  return <View style={styles.settingItem}>
    <View style={styles.settingLabelRow}>
      <View style={theme.Styles.row}>
        <Text style={styles.settingLabel}>{label}</Text>
        {info && <InfoBubble text={info} label={`Help for ${label}`}><Feather name="help-circle" size={16} color={theme.COLORS.subtext} /></InfoBubble>}
      </View>
      <Text style={styles.settingValue}>{value} {unit}</Text>
    </View>
    <GestureHandlerRootView style={styles.sliderWrapper}>
      <GestureDetector gesture={Gesture.Race(pan, tap)}>
        <View accessible accessibilityRole="adjustable" accessibilityLabel={label}
          accessibilityValue={{ min, max, now: Math.max(min, Math.min(max, value)), text: `${value} ${unit}` }}
          accessibilityHint="Swipe up or down to adjust, or tap the track."
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={event => {
            const action = event.nativeEvent.actionName;
            if (action === "increment" || action === "decrement") {
              onValueChange(adjustedSliderValue(value, action === "increment" ? 1 : -1, min, max, discrete, decimalPlaces));
            }
          }}
          style={styles.trackHit} onLayout={event => { sliderWidth.value = event.nativeEvent.layout.width; }}>
          <View style={styles.sliderTrack}>
            <View style={styles.sliderBackground} />
            <Animated.View style={[styles.sliderFill, fillStyle]} />
            {discrete && <View style={styles.stepsContainer}>
              {discrete.map((step, index) => <View key={step} style={[styles.stepDot,
                { left: `${(index / (discrete.length - 1)) * 100}%` }, value >= step && { backgroundColor: theme.COLORS.primary }]} />)}
            </View>}
            <Animated.View style={[styles.thumb, thumbStyle]} />
          </View>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
    {discrete && <View style={styles.stepsLabels} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {discrete.map(step => <Text key={step} style={styles.stepLabel}>{step}</Text>)}
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  settingItem: { marginTop: theme.SPACING.small },
  settingLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6 },
  settingLabel: { color: theme.COLORS.subtext, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
  settingValue: { color: theme.COLORS.primary, fontSize: theme.FONT_SIZE.small, fontWeight: "700" },
  sliderWrapper: { height: 48, justifyContent: "center" },
  trackHit: { height: 48, width: "100%", justifyContent: "center" },
  sliderTrack: { height: 6, width: "100%", justifyContent: "center" },
  sliderBackground: { position: "absolute", height: 6, width: "100%", backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 3 },
  sliderFill: { position: "absolute", height: 6, backgroundColor: theme.COLORS.primary, borderRadius: 3 },
  thumb: { position: "absolute", width: 20, height: 20, borderRadius: 10, backgroundColor: theme.COLORS.text, borderWidth: 2, borderColor: theme.COLORS.primary, elevation: 4 },
  stepsContainer: { position: "absolute", width: "100%", flexDirection: "row", alignItems: "center" },
  stepDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.3)", position: "absolute", marginLeft: -2 },
  stepsLabels: { flexDirection: "row", justifyContent: "space-between" },
  stepLabel: { color: theme.COLORS.subtext, fontSize: 10, flex: 1, textAlign: "center" },
});
