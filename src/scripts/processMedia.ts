import metadata from "@/assets/model/model_metadata.json";
import * as fs from "expo-file-system";
import { beginRun, endRun, getDenoiser } from "./denoiserSingleton";
import { AlignedDenoiseStream } from "./alignedDenoiseStream";
import {
  buildCacheKey, buildDecodeKey, buildDenoiseKey, lookupCachedOutput,
  lookupDecodedPCM, lookupDenoisedPCM, placeOutput, pruneRebuildableCache, stagePcmPath,
  storeCachedOutput, storeDecodedPCM, storeDenoisedPCM,
} from "./denoiseCache";
import { decodeToPCMFile, mergeAudioVideo, PCMtoWav, readPCMChunks, sanitizeFileName, writePCMChunk } from "./formatHandler";
import type { SilenceTrimSettings } from "./silenceTrim";
import { throwIfCancelled, type CancellationToken } from "./batchQueue";
import { recordDiagnostic, recordDiagnosticError } from "./diagnostics";
import type { DiagnosticStage } from "./diagnosticsCore";

export type ProcessingSettings = {
  attenLimDb: number;
  normalize: { toggle: boolean; targetRMS: number; maxPeakDb: number };
  silenceTrim: SilenceTrimSettings;
};
export type ProcessingProgress = { stage: string; percent: number; eta: string | null };
export type ProcessingResult = { file: fs.File; seconds: number; cached: boolean; trimEnabled: boolean };

function remainingTime(seconds: number): string {
  const n = Math.max(0, Math.ceil(seconds));
  if (n >= 3600) return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m left`;
  if (n >= 60) return `${Math.floor(n / 60)}m ${n % 60}s left`;
  return `${n}s left`;
}

/** Process one input, with cooperative cancellation and cleanup of partial files. */
export async function processMedia(
  input: fs.File,
  filename: string,
  video: boolean,
  settings: ProcessingSettings,
  token: CancellationToken,
  onProgress: (value: ProcessingProgress) => void,
): Promise<ProcessingResult> {
  const effectiveTrim: SilenceTrimSettings = video ? { ...settings.silenceTrim, enabled: false } : settings.silenceTrim;
  const kind = video ? "video" : "audio";
  const cacheKey = buildCacheKey(input, { ...settings, silenceTrim: effectiveTrim }, kind);
  const stageNames: Record<string, DiagnosticStage> = {
    "Checking cache...": "cache", "Reusing decoded audio...": "decode", "Extracting audio...": "decode",
    "Analyzing loudness...": "analyze", "Reusing denoised audio...": "cache", "Preparing AI model...": "model",
    "Removing noise...": "denoise", "Finalizing media...": "finalize", "Merging audio and video...": "mux",
  };
  let diagnosticStage: DiagnosticStage = "prepare";
  let stageStart = Date.now();
  let completed = false;
  const progress = (stage: string, percent = 0, eta: string | null = null) => {
    const next = stageNames[stage] ?? "general";
    if (next !== diagnosticStage) {
      recordDiagnostic("process", diagnosticStage, "OK", "info", Date.now() - stageStart);
      diagnosticStage = next; stageStart = Date.now();
      recordDiagnostic("process", diagnosticStage, "START");
    }
    onProgress({ stage, percent, eta });
  };
  const start = Date.now();
  throwIfCancelled(token);
  // Reserve the run before asynchronous cache verification: it may take a
  // long time on large outputs, and incoming shares must wait throughout.
  beginRun();
  recordDiagnostic("process", diagnosticStage, "START");
  // Only files created by this run are cleaned up. Previously indexed PCM and
  // completed outputs belong to the cache/user and must never be swept here.
  const owned = new Set<string>();
  const own = (file: fs.File) => { owned.add(file.uri); return file; };
  const retain = (file: fs.File) => owned.delete(file.uri);
  try {
    progress("Checking cache...");
    try {
      const cached = await lookupCachedOutput(cacheKey, kind);
      throwIfCancelled(token);
      if (cached) { completed = true; return { file: cached, seconds: 0, cached: true, trimEnabled: effectiveTrim.enabled }; }
    } catch (error) {
      throwIfCancelled(token);
      console.warn("Output cache unavailable; processing fresh:", error);
    }
    throwIfCancelled(token);
    const decodeKey = buildDecodeKey(input);
    let pcmFile: fs.File;
    let sampleRate: number;
    const cachedDecode = await lookupDecodedPCM(decodeKey);
    throwIfCancelled(token);
    if (cachedDecode) {
      pcmFile = cachedDecode.file;
      sampleRate = cachedDecode.sampleRate;
      progress("Reusing decoded audio...");
    } else {
      progress("Extracting audio...");
      const staged = own(new fs.File(fs.Paths.cache, stagePcmPath("stage_dec")));
      const decoded = await decodeToPCMFile(input, staged.uri);
      pcmFile = decoded.file;
      sampleRate = decoded.sampleRate;
      throwIfCancelled(token);
      try { await storeDecodedPCM(decodeKey, pcmFile, sampleRate); retain(staged); }
      catch (error) { console.warn("Could not cache decoded audio:", error); }
    }
    const decodedBytes = pcmFile.size;
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(decodedBytes) ||
        decodedBytes <= 0 || decodedBytes % 2 !== 0) {
      throw new Error("The file contains invalid or incomplete decoded audio samples.");
    }
    const totalSamples = decodedBytes / 2;
    // StreamingResampler.finish uses this same count. Check the RIFF limit
    // before spending hours processing an output that WAV cannot represent.
    const expectedSamples = sampleRate === 48000 ? totalSamples : Math.ceil(totalSamples * 48000 / sampleRate - 1e-12);
    const expectedDenoisedBytes = expectedSamples * 2;
    if (!Number.isSafeInteger(expectedDenoisedBytes) || expectedDenoisedBytes <= 0 ||
        expectedDenoisedBytes > 0xffffffff - 36) {
      throw new Error("This audio is too long for a standard WAV. Split the original into shorter files and try again.");
    }
    let globalGain = 1;
    if (settings.normalize.toggle) {
      progress("Analyzing loudness...");
      let maxPeak = 0, sumSquares = 0, analyzed = 0;
      await readPCMChunks(pcmFile, 1024 * 1024, async (chunk, inputSamples) => {
        throwIfCancelled(token);
        for (let i = 0; i < chunk.length; i++) {
          const value = chunk[i];
          sumSquares += value * value;
          maxPeak = Math.max(maxPeak, Math.abs(value));
        }
        analyzed += inputSamples;
        progress("Analyzing loudness...", Math.min(100, Math.round(analyzed / totalSamples * 100)));
      });
      if (analyzed !== totalSamples) throw new Error("Incomplete PCM read during loudness analysis.");
      const currentRms = Math.sqrt(sumSquares / totalSamples);
      const targetRms = Math.pow(10, settings.normalize.targetRMS / 20);
      const targetPeak = Math.pow(10, settings.normalize.maxPeakDb / 20);
      globalGain = Math.min(currentRms > 1e-8 ? targetRms / currentRms : 1,
        maxPeak > 1e-8 ? targetPeak / maxPeak : 1, 5);
    }

    throwIfCancelled(token);
    const denoiseKey = buildDenoiseKey(input, settings);
    let denoisedPcmFile: fs.File;
    const cachedDenoise = await lookupDenoisedPCM(denoiseKey);
    throwIfCancelled(token);
    if (cachedDenoise && cachedDenoise.size === expectedDenoisedBytes) {
      denoisedPcmFile = cachedDenoise;
      progress("Reusing denoised audio...");
    } else {
      progress("Preparing AI model...");
      const denoiser = await getDenoiser();
      throwIfCancelled(token);
      const targetRate = 48000;
      const hopSize = metadata.hop_size;
      const stream = denoiser.createStream(settings.attenLimDb);
      const aligned = new AlignedDenoiseStream(hopSize, metadata.algorithmic_delay_samples, async frame => {
        throwIfCancelled(token);
        return denoiser.processFrame(stream, frame);
      });
      const staged = own(new fs.File(fs.Paths.cache, stagePcmPath("stage_dn")));
      denoisedPcmFile = staged;
      let processedInput = 0;
      let firstWrite = true;
      const write = async (samples: Float32Array) => {
        if (!samples.length) return;
        await writePCMChunk(staged, samples, !firstWrite);
        firstWrite = false;
      };
      const modelStart = Date.now();
      progress("Removing noise...");
      await readPCMChunks(pcmFile, sampleRate * 5, async (chunk, inputSamples) => {
        throwIfCancelled(token);
        if (settings.normalize.toggle) for (let i = 0; i < chunk.length; i++) chunk[i] *= globalGain;
        await write(await aligned.push(chunk));
        processedInput += inputSamples;
        const percent = Math.min(100, Math.round(processedInput / totalSamples * 100));
        const elapsed = (Date.now() - modelStart) / 1000;
        const remaining = percent > 0 ? elapsed / (percent / 100) - elapsed : 0;
        progress("Removing noise...", percent, remaining > 0 && Number.isFinite(remaining) ? remainingTime(remaining) : null);
      }, sampleRate, targetRate);
      throwIfCancelled(token);
      await write(await aligned.finish());
      if (firstWrite) throw new Error("The audio contains no samples after resampling.");
      if (processedInput !== totalSamples || !staged.exists || staged.size !== expectedDenoisedBytes) {
        throw new Error("Incomplete denoised audio; the original has been kept. Please retry.");
      }
      throwIfCancelled(token);
      try { await storeDenoisedPCM(denoiseKey, staged); retain(staged); }
      catch (error) { console.warn("Could not cache denoised audio:", error); }
    }

    throwIfCancelled(token);
    progress("Finalizing media...");
    const base = filename.includes(".") ? filename.slice(0, filename.lastIndexOf(".")) : filename;
    const wavResult = await PCMtoWav(denoisedPcmFile, 48000, effectiveTrim);
    const wav = own(wavResult.file);
    throwIfCancelled(token);
    let result: fs.File;
    if (video) {
      progress("Merging audio and video...");
      const merged = own(await mergeAudioVideo(input, wav, {
        startUs: wavResult.trimStartUs, endUs: wavResult.trimEndUs, trimmed: wavResult.trimmed,
      }));
      throwIfCancelled(token);
      const oldUri = merged.uri;
      result = await placeOutput(merged, `${sanitizeFileName(base || "video")}_denoised.mp4`);
      owned.delete(oldUri);
    } else {
      const oldUri = wav.uri;
      result = await placeOutput(wav, `${sanitizeFileName(base || "audio")}_denoised.wav`);
      owned.delete(oldUri);
    }
    // Do not cancel after the output has been committed: it is a successful,
    // persistent result even if Stop was pressed during the final file move.
    try { await storeCachedOutput(cacheKey, result); }
    catch (error) { console.warn("Could not index finished output:", error); }
    completed = true;
    return { file: result, seconds: (Date.now() - start) / 1000, cached: false, trimEnabled: effectiveTrim.enabled };
  } catch (error) {
    recordDiagnosticError("process", diagnosticStage, error);
    throw error;
  } finally {
    if (completed) recordDiagnostic("process", diagnosticStage, "OK", "info", Date.now() - stageStart);
    for (const uri of owned) {
      try { const file = new fs.File(uri); if (file.exists) file.delete(); }
      catch (error) { console.warn("Could not remove partial processing file:", error); }
    }
    endRun();
    // Rebuildable stages are pruned only after all active jobs/recordings stop.
    try { await pruneRebuildableCache(); }
    catch (error) { console.warn("Could not prune temporary PCM cache:", error); }
  }
}
