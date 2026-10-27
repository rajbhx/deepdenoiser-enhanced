import { File, Paths } from "expo-file-system";
import { suggestCoreLevel } from "./deviceCores";

export type CoreLevel = 2 | 4 | 8;
export type CoreMode = "auto" | CoreLevel;
export type RuntimeMode = "auto" | "xnnpack" | "cpu" | "nnapi" | "gpu";
export type AttenPreset = "light" | "medium" | "strong" | "max" | "custom";

export const ATTEN_PRESET_DB: Record<Exclude<AttenPreset, "custom">, number> = {
  light: 20,
  medium: 10,
  strong: 5,
  max: 0,
};

export interface AppSettings {
  checkForUpdates: boolean;
  denoiseCount: number;
  /** @deprecated Prefer runtime */
  cpuOnly: boolean;
  /** Manual core count when coreMode is not auto */
  coreLevel: CoreLevel;
  /** auto = derive from device model; else fixed coreLevel */
  coreMode: CoreMode;
  runtime: RuntimeMode;
  attenPreset: AttenPreset;
  /** Last attenuation limit in dB (0 = strongest denoise) */
  attenLimDb: number;
}

const SETTINGS_FILE_NAME = "app_settings.json";

const DEFAULT_SETTINGS: AppSettings = {
  checkForUpdates: false,
  denoiseCount: 0,
  cpuOnly: true,
  coreLevel: 4,
  coreMode: "auto",
  runtime: "auto",
  attenPreset: "max",
  attenLimDb: 0,
};

function normalizeRuntime(parsed: Partial<AppSettings>): RuntimeMode {
  if (
    parsed.runtime === "auto" ||
    parsed.runtime === "xnnpack" ||
    parsed.runtime === "cpu" ||
    parsed.runtime === "nnapi" ||
    parsed.runtime === "gpu"
  ) {
    return parsed.runtime;
  }
  if (parsed.cpuOnly === false) return "nnapi";
  return "auto";
}

function normalizeCoreMode(parsed: Partial<AppSettings>): CoreMode {
  if (parsed.coreMode === "auto") return "auto";
  if (parsed.coreMode === 2 || parsed.coreMode === 4 || parsed.coreMode === 8) {
    return parsed.coreMode;
  }
  // Legacy installs only had coreLevel
  if (parsed.coreLevel === 2 || parsed.coreLevel === 4 || parsed.coreLevel === 8) {
    return parsed.coreLevel;
  }
  return "auto";
}

/** Effective thread count after applying auto device policy. */
export function resolveCoreLevel(settings: AppSettings): CoreLevel {
  if (settings.coreMode === "auto") {
    return suggestCoreLevel();
  }
  return settings.coreMode;
}

export async function getSettings(): Promise<AppSettings> {
  try {
    const file = new File(Paths.document, SETTINGS_FILE_NAME);
    if (!file.exists) {
      return DEFAULT_SETTINGS;
    }
    const content = await file.text();
    const parsed = JSON.parse(content) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    const runtime = normalizeRuntime(parsed);
    const coreMode = normalizeCoreMode(parsed);
    const coreLevel: CoreLevel =
      merged.coreLevel === 2 || merged.coreLevel === 8 ? merged.coreLevel : 4;
    let attenPreset: AttenPreset = merged.attenPreset ?? "max";
    if (!["light", "medium", "strong", "max", "custom"].includes(attenPreset)) {
      attenPreset = "max";
    }
    const attenLimDb =
      typeof merged.attenLimDb === "number" && merged.attenLimDb >= 0
        ? merged.attenLimDb
        : ATTEN_PRESET_DB[attenPreset === "custom" ? "max" : attenPreset];
    return {
      ...merged,
      cpuOnly: runtime === "auto" || runtime === "xnnpack" || runtime === "cpu",
      coreLevel,
      coreMode,
      runtime,
      attenPreset,
      attenLimDb,
    };
  } catch (error) {
    console.error("Error reading settings:", error);
    return DEFAULT_SETTINGS;
  }
}

export async function updateSettings(newSettings: Partial<AppSettings>): Promise<AppSettings> {
  const currentSettings = await getSettings();
  const updatedSettings = { ...currentSettings, ...newSettings };
  if (newSettings.runtime) {
    updatedSettings.cpuOnly =
      newSettings.runtime === "auto" ||
      newSettings.runtime === "xnnpack" ||
      newSettings.runtime === "cpu";
  }
  if (newSettings.attenPreset && newSettings.attenPreset !== "custom") {
    updatedSettings.attenLimDb = ATTEN_PRESET_DB[newSettings.attenPreset];
  }
  try {
    const file = new File(Paths.document, SETTINGS_FILE_NAME);
    if (!file.exists) {
      file.create();
    }
    await file.write(JSON.stringify(updatedSettings));
    return updatedSettings;
  } catch (error) {
    console.error("Error saving settings:", error);
    return updatedSettings;
  }
}

export async function incrementDenoiseCount(): Promise<void> {
  const settings = await getSettings();
  await updateSettings({ denoiseCount: settings.denoiseCount + 1 });
}
