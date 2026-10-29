import { Asset } from "expo-asset";
import { DeepFilterNet } from "./Denoiser";
import { getSettings, resolveCoreLevel, type RuntimeMode } from "./settings";

let instance: DeepFilterNet | null = null;
let loadedKey: string | null = null;
let activeRuns = 0;
let pendingReset = false;
let operations: Promise<void> = Promise.resolve();
const runListeners = new Set<() => void>();

/** Observe the shared recording/processing guard without polling. */
export function subscribeProcessingActivity(listener: () => void): () => void {
  runListeners.add(listener);
  return () => { runListeners.delete(listener); };
}
function notifyRunListeners(): void {
  for (const listener of runListeners) {
    try { listener(); } catch (error) { console.warn("Could not notify processing observer:", error); }
  }
}

/** Serialize loading/releasing; a failed load must not poison the queue. */
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation, operation);
  operations = result.then(() => undefined, () => undefined);
  return result;
}

export function beginRun(): void { activeRuns++; notifyRunListeners(); }
export function endRun(): void {
  activeRuns = Math.max(0, activeRuns - 1);
  notifyRunListeners();
  if (activeRuns === 0 && pendingReset) void resetDenoiser();
}
export function getEngineLabel(): string { return instance?.lastEngine ?? "not-loaded"; }
/** Used to avoid deleting app-owned media while a pipeline is using it. */
export function isProcessingMedia(): boolean { return activeRuns > 0; }

export function resetDenoiser(): Promise<void> {
  if (activeRuns > 0) { pendingReset = true; return Promise.resolve(); }
  return exclusive(async () => {
    // A run may have started while this reset waited for a model load.
    if (activeRuns > 0) { pendingReset = true; return; }
    pendingReset = false;
    const old = instance;
    instance = null;
    loadedKey = null;
    if (old) await old.release();
  });
}

export async function getDenoiser(): Promise<DeepFilterNet> {
  const settings = await getSettings();
  const { runtime } = settings;
  const coreLevel = resolveCoreLevel(settings);
  const key = `${runtime}:${settings.coreMode}:${coreLevel}`;
  return exclusive(async () => {
    if (instance && loadedKey === key) return instance;
    if (instance && activeRuns > 0) {
      // Don't free a session already used by a pipeline. Apply new hardware
      // settings after the last run finishes.
      pendingReset = true;
      return instance;
    }
    if (instance) {
      const old = instance;
      instance = null;
      loadedKey = null;
      await old.release();
    }
    const denoiser = new DeepFilterNet();
    try {
      const modelAsset = Asset.fromModule(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@/assets/model/denoiser_model.ort"),
      );
      await modelAsset.downloadAsync();
      if (!modelAsset.localUri) throw new Error("Model asset has no local URI after download");
      const mode: RuntimeMode = runtime;
      console.log(`[DeepFilterNet] loading runtime=${mode} coreMode=${settings.coreMode} threads=${coreLevel}`);
      await denoiser.loadModel(modelAsset.localUri, mode, coreLevel);
      instance = denoiser;
      loadedKey = key;
      console.log(`[DeepFilterNet] ready engine=${denoiser.lastEngine}`);
      return denoiser;
    } catch (error) {
      await denoiser.release();
      throw error;
    }
  });
}
