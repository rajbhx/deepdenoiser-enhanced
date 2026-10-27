import { Asset } from "expo-asset";
import { DeepFilterNet } from "./Denoiser";
import { getSettings, resolveCoreLevel, type RuntimeMode } from "./settings";

let instance: DeepFilterNet | null = null;
let loadPromise: Promise<DeepFilterNet> | null = null;
let loadedKey: string | null = null;

/**
 * Number of in-flight pipelines using the shared session. SettingsSidebar
 * calls resetDenoiser() on runtime/core changes; releasing the session under
 * an active session.run() used to free native memory mid-inference (AUD-01).
 */
let activeRuns = 0;
let pendingReset = false;

export function beginRun(): void {
  activeRuns++;
}

export function endRun(): void {
  activeRuns = Math.max(0, activeRuns - 1);
  if (activeRuns === 0 && pendingReset) {
    pendingReset = false;
    void resetDenoiser();
  }
}

export function getEngineLabel(): string {
  return instance?.lastEngine ?? "not-loaded";
}

export async function resetDenoiser(): Promise<void> {
  if (activeRuns > 0) {
    // Defer until the last pipeline finishes (endRun triggers it).
    pendingReset = true;
    return;
  }
  const current = instance;
  instance = null;
  loadPromise = null;
  loadedKey = null;
  if (current) await current.release();
}

export async function getDenoiser(): Promise<DeepFilterNet> {
  const settings = await getSettings();
  const { runtime } = settings;
  const coreLevel = resolveCoreLevel(settings);
  const key = `${runtime}:${settings.coreMode}:${coreLevel}`;
  if (instance && loadedKey === key) return instance;
  if (instance && loadedKey !== key) {
    await resetDenoiser();
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      const denoiser = new DeepFilterNet();
      const modelAsset = Asset.fromModule(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@/assets/model/denoiser_model.ort"),
      );
      await modelAsset.downloadAsync();
      if (!modelAsset.localUri) {
        throw new Error("Model asset has no local URI after download");
      }
      const mode: RuntimeMode = runtime;
      console.log(
        `[DeepFilterNet] getDenoiser runtime=${mode} coreMode=${settings.coreMode} threads=${coreLevel}`,
      );
      await denoiser.loadModel(modelAsset.localUri, mode, coreLevel);
      instance = denoiser;
      loadedKey = key;
      console.log(`[DeepFilterNet] ready engine=${denoiser.lastEngine}`);
      return denoiser;
    })();
    loadPromise = loadPromise.catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}
