import metadata from "@/assets/model/model_metadata.json";
import * as fs from "expo-file-system";
import { beginRun, endRun, getDenoiser } from "./denoiserSingleton";
import {
  buildCacheKey, buildDecodeKey, buildDenoiseKey, lookupCachedOutput,
  lookupDecodedPCM, lookupDenoisedPCM, placeOutput, stagePcmPath,
  storeCachedOutput, storeDecodedPCM, storeDenoisedPCM,
} from "./denoiseCache";
import { decodeToPCMFile, mergeAudioVideo, PCMtoWav, readPCMChunks, sanitizeFileName, writePCMChunk } from "./formatHandler";
import type { SilenceTrimSettings } from "./silenceTrim";
import { throwIfCancelled, type CancellationToken } from "./batchQueue";

export type ProcessingSettings = {
  attenLimDb: number;
  normalize: { toggle: boolean; targetRMS: number; maxPeakDb: number };
  silenceTrim: SilenceTrimSettings;
};
export type ProcessingProgress = { stage: string; percent: number; eta: string | null };
export type ProcessingResult = { file: fs.File; seconds: number; cached: boolean; trimEnabled: boolean };

export function isVideoFile(file: fs.File, name: string): boolean {
  return !!file.type?.startsWith("video") || /\.(mp4|mov|mkv|avi|m4v|webm)$/i.test(name);
}

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
  const cacheKey = buildCacheKey(input, { ...settings, silenceTrim: effectiveTrim });
  const progress = (stage: string, percent = 0, eta: string | null = null) => onProgress({ stage, percent, eta });
  const start = Date.now();
  throwIfCancelled(token);
  progress("Checking cache...");
  try {
    const cached = await lookupCachedOutput(cacheKey);
    throwIfCancelled(token);
    if (cached) return { file: cached, seconds: 0, cached: true, trimEnabled: effectiveTrim.enabled };
  } catch (error) {
    throwIfCancelled(token);
    console.warn("Output cache unavailable; processing fresh:", error);
  }

  beginRun();
  // Only files created by this run are cleaned up. Previously indexed PCM and
  // completed outputs belong to the cache/user and must never be swept here.
  const owned = new Set<string>();
  const own = (file: fs.File) => { owned.add(file.uri); return file; };
  const retain = (file: fs.File) => owned.delete(file.uri);
  try {
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
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || pcmFile.size <= 0) {
      throw new Error("The file contains no decodable audio samples.");
    }
    const totalSamples = pcmFile.size / 2;
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
    if (cachedDenoise) {
      denoisedPcmFile = cachedDenoise;
      progress("Reusing denoised audio...");
    } else {
      progress("Preparing AI model...");
      const denoiser = await getDenoiser();
      throwIfCancelled(token);
      const targetRate = 48000;
      const hopSize = metadata.hop_size;
      const fftSize = metadata.fft_size;
      const stream = denoiser.createStream(settings.attenLimDb);
      const staged = own(new fs.File(fs.Paths.cache, stagePcmPath("stage_dn")));
      denoisedPcmFile = staged;
      let buffer = new Float32Array(fftSize);
      let processedInput = 0, outputSkipped = 0;
      let firstWrite = true;
      const modelStart = Date.now();
      progress("Removing noise...");
      await readPCMChunks(pcmFile, sampleRate * 5, async (chunk, inputSamples) => {
        throwIfCancelled(token);
        if (settings.normalize.toggle) for (let i = 0; i < chunk.length; i++) chunk[i] *= globalGain;
        const combined = new Float32Array(buffer.length + chunk.length);
        combined.set(buffer); combined.set(chunk, buffer.length);
        const processLen = Math.floor(combined.length / hopSize) * hopSize;
        const toProcess = combined.subarray(0, processLen);
        buffer = combined.slice(processLen);
        const output = new Float32Array(processLen);
        for (let i = 0; i < processLen; i += hopSize) {
          throwIfCancelled(token);
          await denoiser.processFrame(stream, toProcess.subarray(i, i + hopSize), output, i);
        }
        let final = output;
        if (outputSkipped < fftSize) {
          const skip = Math.min(fftSize - outputSkipped, final.length);
          final = final.subarray(skip); outputSkipped += skip;
        }
        if (final.length > 0) {
          await writePCMChunk(staged, final, !firstWrite);
          firstWrite = false;
        }
        processedInput += inputSamples;
        const percent = Math.min(100, Math.round(processedInput / totalSamples * 100));
        const elapsed = (Date.now() - modelStart) / 1000;
        const remaining = percent > 0 ? elapsed / (percent / 100) - elapsed : 0;
        progress("Removing noise...", percent, remaining > 0 && Number.isFinite(remaining) ? remainingTime(remaining) : null);
      }, sampleRate, targetRate);
      throwIfCancelled(token);
      if (buffer.length > 0) {
        const padded = new Float32Array(hopSize);
        padded.set(buffer);
        const frame = await denoiser.processFrame(stream, padded, new Float32Array(hopSize));
        let final = frame.subarray(0, buffer.length);
        if (outputSkipped < fftSize) {
          const skip = Math.min(fftSize - outputSkipped, final.length);
          final = final.subarray(skip);
        }
        if (final.length > 0) await writePCMChunk(staged, final, !firstWrite);
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
    return { file: result, seconds: (Date.now() - start) / 1000, cached: false, trimEnabled: effectiveTrim.enabled };
  } finally {
    for (const uri of owned) {
      try { const file = new fs.File(uri); if (file.exists) file.delete(); }
      catch (error) { console.warn("Could not remove partial processing file:", error); }
    }
    endRun();
  }
}
