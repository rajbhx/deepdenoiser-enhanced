import Constants from "expo-constants";
import type { CoreLevel } from "./settings";

/**
 * Pick a sensible XNNPACK thread count from the device name.
 * OnePlus 7 / 7T / 7 Pro (SD855 / 855+) → 4.
 */
export function suggestCoreLevel(): CoreLevel {
  const blob = [Constants.deviceName, Constants.expoConfig?.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  console.log(`[DeepFilterNet] device hint: "${blob || "unknown"}"`);

  if (/go\b|\blite\b|nokia\s*c|redmi\s*[1-5]\b/.test(blob)) {
    return 2;
  }

  if (/oneplus\s*7|gm19|hd19|gm190|in201|sdm855|sm8150|adreno\s*640/.test(blob)) {
    return 4;
  }

  return 4;
}
