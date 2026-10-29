import { Feather } from "@expo/vector-icons";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { getDenoiser } from "@/src/scripts/denoiserSingleton";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ ...Feather.font });
  const ready = fontsLoaded || !!fontError;
  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync();
    void getDenoiser().catch((error) => console.warn("[DeepFilterNet] preload failed:", error));
  }, [ready]);
  if (!ready) return null;
  // Import uses Android's document picker. Microphone permission is requested
  // only when recording starts, and media permission only when saving. A user
  // who denies either can still use the rest of the app.
  return <SafeAreaProvider><Stack screenOptions={{ headerShown: false }} initialRouteName="(tabs)">
    <Stack.Screen name="(tabs)" /><Stack.Screen name="processing" />
  </Stack></SafeAreaProvider>;
}
