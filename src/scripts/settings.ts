import { File, Paths } from "expo-file-system";
import { atomicReplaceFile } from "@/modules/AudioProcessorModule";
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
      return { ...DEFAULT_SETTINGS };
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
    return { ...DEFAULT_SETTINGS };
  }
}

// Serialise read-modify-write so simultaneous UI updates never clobber one
// another. A failed write is propagated but does not poison the queue.
let settingsQueue: Promise<void> = Promise.resolve();
function queueSettings<T>(work: () => Promise<T>): Promise<T> {
  const result = settingsQueue.then(work, work);
  settingsQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function updateSettingsUnlocked(newSettings: Partial<AppSettings>): Promise<AppSettings> {
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
  const target = new File(Paths.document, SETTINGS_FILE_NAME);
  const tempName = `${SETTINGS_FILE_NAME}.${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`;
  const temp = new File(Paths.document, tempName);
  try {
    await temp.write(JSON.stringify(updatedSettings));
    await atomicReplaceFile(temp.uri, target.uri);
  } catch (error) {
    console.error("Error saving settings:", error);
    throw new Error(`Could not save settings: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    const leftover = new File(Paths.document, tempName);
    if (leftover.exists) {
      try { leftover.delete(); } catch { /* best effort */ }
    }
  }
  return updatedSettings;
}

export function updateSettings(newSettings: Partial<AppSettings>): Promise<AppSettings> {
  return queueSettings(() => updateSettingsUnlocked(newSettings));
}

export function incrementDenoiseCount(): Promise<void> {
  return queueSettings(async () => {
    const settings = await getSettings();
    await updateSettingsUnlocked({ denoiseCount: settings.denoiseCount + 1 });
  });
}
