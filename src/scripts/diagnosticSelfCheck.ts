import { fingerprintFile, pcmToWav } from "@/modules/AudioProcessorModule";
import * as fs from "expo-file-system";
import type { DeepFilterNet } from "./Denoiser";
import {
  beginDiagnosticRun, endDiagnosticRun, getBundledModelUri, getDenoiser, withDiagnosticModel,
} from "./denoiserSingleton";
import { recordDiagnostic, recordDiagnosticError } from "./diagnostics";
import { assertNativeRecorderIdle } from "./recordingSafety";
import type { RuntimeMode } from "./settings";

const MODEL_SHA256 = "ec5ec24059035741763006dfaa6d463cfbbacf496caed5b5599ebe3477f2dd5b";
const FIXTURE_SHA256 = "daf6bc4926a633c4077b0b74d935141a9e416aeb67b4550960495110ddc96f9f";
const SAMPLES = 8192;

export type DiagnosticCheck = {
  id: "private-file" | "wav" | "model-hash" | "model-run" | "benchmark";
  label: string;
  status: "passed" | "failed" | "warning";
  detail: string;
  elapsedMs?: number;
};
export type DiagnosticRunResult = { checks: DiagnosticCheck[]; attemptedEngine: string | null; realtimeFactor: number | null };

async function withReservation<T>(work: () => Promise<T>): Promise<T> {
  // The existing native writer liveness check is fail-closed; never run a
  // diagnostic over an active or uncertain recording.
  try { assertNativeRecorderIdle(); }
  catch { throw new Error("Cannot confirm the recorder is idle. Finish recording or check recorder status before diagnostics."); }
  if (!beginDiagnosticRun()) throw new Error("Recording or processing is active. Wait until it finishes before running diagnostics.");
  recordDiagnostic("diagnostics", "self-check", "START");
  try { return await work(); }
  finally { endDiagnosticRun(); }
}

function tone(): Float32Array {
  const result = new Float32Array(SAMPLES);
  for (let i = 0; i < result.length; i++) result[i] = 0.05 * Math.sin(2 * Math.PI * 440 * i / 48000);
  return result;
}

async function modelRun(model: DeepFilterNet): Promise<{ elapsedMs: number; realtimeFactor: number; attemptedEngine: string }> {
  const signal = tone();
  const start = Date.now();
  const output = await model.denoise(signal);
  const elapsedMs = Math.max(1, Date.now() - start);
  if (!(output instanceof Float32Array) || output.length !== signal.length || !output.every(Number.isFinite)) {
    throw new Error("Model returned invalid synthetic audio");
  }
  return { elapsedMs, realtimeFactor: (signal.length / 48000) / (elapsedMs / 1000), attemptedEngine: model.lastEngine };
}

/** Only files created by this test are removed. A collision is never overwritten. */
async function checkPrivateFiles(checks: DiagnosticCheck[]): Promise<void> {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  const pcm = new fs.File(fs.Paths.cache, `dd_diagnostic_${id}.pcm`);
  const wav = new fs.File(fs.Paths.cache, `dd_diagnostic_${id}.wav`);
  let ownsPcm = false, ownsWav = false;
  const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37 + 17) % 256);
  try {
    const start = Date.now();
    try {
      pcm.create({ overwrite: false }); ownsPcm = true;
      await pcm.write(bytes);
      const read = await pcm.bytes();
      if (read.length !== bytes.length || !read.every((value, i) => value === bytes[i])) throw new Error("Synthetic file integrity failed");
      const handle = pcm.open();
      try {
        handle.offset = 0;
        const shortRead = handle.readBytes(bytes.length * 2);
        if (shortRead.length !== bytes.length) throw new Error("Synthetic short read failed");
      } finally { handle.close(); }
      const hash = await fingerprintFile(pcm.uri);
      if (hash.sha256 !== FIXTURE_SHA256 || hash.bytes !== bytes.length) throw new Error("Synthetic file fingerprint failed");
      checks.push({ id: "private-file", label: "Private file and short-read check", status: "passed", detail: "Synthetic bytes were read and verified. No user media was opened.", elapsedMs: Date.now() - start });
      recordDiagnostic("diagnostics", "storage", "OK", "info", Date.now() - start);
    } catch (error) {
      recordDiagnosticError("diagnostics", "storage", error);
      checks.push({ id: "private-file", label: "Private file and short-read check", status: "failed", detail: "Could not verify the synthetic private file. Check available space and recent diagnostic events." });
      return;
    }
    const wavStart = Date.now();
    try {
      wav.create({ overwrite: false }); ownsWav = true;
      await pcmToWav(pcm.uri, wav.uri, 48000, 1, 16, null);
      const result = await wav.bytes();
      const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
      const tag = (offset: number) => String.fromCharCode(...result.subarray(offset, offset + 4));
      if (result.length !== bytes.length + 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" ||
          tag(36) !== "data" || view.getUint32(40, true) !== bytes.length ||
          !bytes.every((value, i) => result[i + 44] === value)) throw new Error("Synthetic WAV integrity failed");
      checks.push({ id: "wav", label: "Synthetic WAV conversion", status: "passed", detail: "The header and copied sample bytes matched.", elapsedMs: Date.now() - wavStart });
      recordDiagnostic("diagnostics", "finalize", "OK", "info", Date.now() - wavStart);
    } catch (error) {
      recordDiagnosticError("diagnostics", "finalize", error);
      checks.push({ id: "wav", label: "Synthetic WAV conversion", status: "failed", detail: "The synthetic WAV could not be verified. Your media was not modified." });
    }
  } finally {
    let cleanupFailed = false;
    for (const [file, owned] of [[pcm, ownsPcm], [wav, ownsWav]] as const) {
      if (owned) try { if (file.exists) file.delete(); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) checks.push({ id: "private-file", label: "Temporary test cleanup", status: "warning", detail: "A test-only cache file could not be removed; no user media was deleted." });
  }
}

/** Tests only a bundled model and unique, app-created synthetic temporary files. */
export async function runDiagnosticSelfCheck(): Promise<DiagnosticRunResult> {
  return withReservation(async () => {
    const checks: DiagnosticCheck[] = [];
    let attemptedEngine: string | null = null;
    let realtimeFactor: number | null = null;
    let modelVerified = false;
    await checkPrivateFiles(checks);
    const hashStart = Date.now();
    try {
      const model = await fingerprintFile(await getBundledModelUri());
      if (model.sha256 !== MODEL_SHA256) throw new Error("Bundled model integrity failed");
      modelVerified = true;
      checks.push({ id: "model-hash", label: "Bundled model identity", status: "passed", detail: "The bundled model matched the expected SHA-256.", elapsedMs: Date.now() - hashStart });
      recordDiagnostic("diagnostics", "model", "OK", "info", Date.now() - hashStart);
    } catch (error) {
      recordDiagnosticError("diagnostics", "model", error);
      checks.push({ id: "model-hash", label: "Bundled model identity", status: "failed", detail: "The bundled model could not be verified. This is not a model-license check." });
    }
    if (modelVerified) {
      try {
        const result = await modelRun(await getDenoiser());
        attemptedEngine = result.attemptedEngine; realtimeFactor = result.realtimeFactor;
        checks.push({ id: "model-run", label: "Synthetic model processing", status: "passed", detail: "The model returned the expected number of finite samples. This does not certify sound quality.", elapsedMs: result.elapsedMs });
        recordDiagnostic("diagnostics", "model", "OK", "info", result.elapsedMs);
      } catch (error) {
        recordDiagnosticError("diagnostics", "model", error);
        checks.push({ id: "model-run", label: "Synthetic model processing", status: "failed", detail: "The synthetic model test did not complete. Check runtime settings and try again while idle." });
      }
    } else {
      checks.push({ id: "model-run", label: "Synthetic model processing", status: "warning", detail: "Not run because the model identity could not be verified." });
    }
    recordDiagnostic("diagnostics", "self-check", checks.some(check => check.status === "failed") ? "FAIL_UNKNOWN" : "OK", checks.some(check => check.status === "failed") ? "error" : "info");
    return { checks, attemptedEngine, realtimeFactor };
  });
}

/** Manual provider comparison: isolated session, no saved-settings changes. */
export async function benchmarkDiagnosticProvider(mode: Extract<RuntimeMode, "cpu" | "xnnpack" | "nnapi">): Promise<DiagnosticRunResult> {
  return withReservation(async () => {
    try {
      const model = await fingerprintFile(await getBundledModelUri());
      if (model.sha256 !== MODEL_SHA256) throw new Error("Bundled model integrity failed");
      const result = await withDiagnosticModel(mode, modelRun);
      recordDiagnostic("diagnostics", "model", "OK", "info", result.elapsedMs);
      return { checks: [{ id: "benchmark", label: `${mode.toUpperCase()} short test`, status: "passed", detail: "The attempted provider may have fallen back; this short timing is indicative only.", elapsedMs: result.elapsedMs }], attemptedEngine: result.attemptedEngine, realtimeFactor: result.realtimeFactor };
    } catch (error) {
      recordDiagnosticError("diagnostics", "model", error);
      return { checks: [{ id: "benchmark", label: `${mode.toUpperCase()} short test`, status: "failed", detail: "This provider test did not complete. No saved runtime setting was changed." }], attemptedEngine: null, realtimeFactor: null };
    }
  });
}
