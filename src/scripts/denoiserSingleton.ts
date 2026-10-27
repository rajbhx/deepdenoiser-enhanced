import { Asset } from "expo-asset";
import { DeepFilterNet } from "./Denoiser";
import { getSettings, resolveCoreLevel, type RuntimeMode } from "./settings";

let instance: DeepFilterNet | null = null;
let loadPromise: Promise<DeepFilterNet> | null = null;
let loadedKey: string | null = null;

export function getEngineLabel(): string {
  return instance?.lastEngine ?? "not-loaded";
}

export async function resetDenoiser(): Promise<void> {
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
