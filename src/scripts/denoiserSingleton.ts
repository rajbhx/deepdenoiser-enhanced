import { Asset } from "expo-asset";
import { DeepFilterNet } from "./Denoiser";
import { getSettings, resolveCoreLevel, type RuntimeMode } from "./settings";

let instance: DeepFilterNet | null = null;
let loadedKey: string | null = null;
let activeRuns = 0;
let diagnosticRun = false;
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

/** Prevent a manual diagnostic test from overlapping file processing or recording. */
export function beginRun(): void {
  if (diagnosticRun) throw new Error("Diagnostics are running. Wait for the self-check to finish.");
  activeRuns++; notifyRunListeners();
}
export function beginDiagnosticRun(): boolean {
  if (activeRuns > 0 || diagnosticRun) return false;
  diagnosticRun = true;
  activeRuns++;
  notifyRunListeners();
  return true;
}
export function endDiagnosticRun(): void {
  if (!diagnosticRun) return;
  diagnosticRun = false;
  endRun();
}
export function endRun(): void {
  activeRuns = Math.max(0, activeRuns - 1);
  notifyRunListeners();
  if (activeRuns === 0 && !diagnosticRun && pendingReset) void resetDenoiser();
}
export function getEngineLabel(): string { return instance?.lastEngine ?? "not-loaded"; }
/** Used to avoid deleting app-owned media while a pipeline is using it. */
export function isProcessingMedia(): boolean { return activeRuns > 0 || diagnosticRun; }

export function resetDenoiser(): Promise<void> {
  if (activeRuns > 0 || diagnosticRun) { pendingReset = true; return Promise.resolve(); }
  return exclusive(async () => {
    // A run may have started while this reset waited for a model load.
    if (activeRuns > 0 || diagnosticRun) { pendingReset = true; return; }
    pendingReset = false;
    const old = instance;
    instance = null;
    loadedKey = null;
    if (old) await old.release();
  });
}

/** Resolve the bundled asset only; does not open or inspect user media. */
export async function getBundledModelUri(): Promise<string> {
  const asset = Asset.fromModule(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/assets/model/denoiser_model.ort"),
  );
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error("Model asset has no local URI after download");
  return asset.localUri;
}

/**
 * A manual benchmark uses a separate session, one provider at a time. Keep
 * the existing load/reset queue locked, never change saved settings, and free
 * the normal singleton before creating the isolated session to limit memory.
 */
export async function withDiagnosticModel<T>(
  mode: RuntimeMode, work: (model: DeepFilterNet) => Promise<T>,
): Promise<T> {
  if (!diagnosticRun) throw new Error("Diagnostics must reserve the model first.");
  return exclusive(async () => {
    if (!diagnosticRun) throw new Error("Diagnostics are no longer active.");
    const old = instance;
    instance = null;
    loadedKey = null;
    if (old) await old.release();
    const settings = await getSettings();
    const model = new DeepFilterNet();
    try {
      await model.loadModel(await getBundledModelUri(), mode, resolveCoreLevel(settings));
      return await work(model);
    } finally { await model.release(); }
  });
}

export async function getDenoiser(): Promise<DeepFilterNet> {
  const settings = await getSettings();
  const { runtime } = settings;
  const coreLevel = resolveCoreLevel(settings);
  const key = `${runtime}:${settings.coreMode}:${coreLevel}`;
  return exclusive(async () => {
    if (instance && loadedKey === key) return instance;
    if (instance && (activeRuns > 0 || diagnosticRun)) {
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
      const modelUri = await getBundledModelUri();
      const mode: RuntimeMode = runtime;
      console.log(`[DeepFilterNet] loading runtime=${mode} coreMode=${settings.coreMode} threads=${coreLevel}`);
      await denoiser.loadModel(modelUri, mode, coreLevel);
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
