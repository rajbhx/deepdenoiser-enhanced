import {
  decodeToPCM,
  extractAndTranscodeAudio,
  extractWavAudio,
  exportMediaFile,
  mixAudioVideo,
  pcmToWav as nativePcmToWav
} from "@/modules/AudioProcessorModule";
import * as fs from "expo-file-system";
import { requestPermissionsAsync } from "expo-media-library";
import { Platform } from "react-native";
import { trackAppEvent } from "./analytics";
import type { SilenceTrimSettings } from "./silenceTrim";
import { trimToNativeConfig } from "./silenceTrim";
import { StreamingResampler } from "./resampler";

const ILLEGAL_FS_CHARS = /[^a-zA-Z0-9._-]/g;

/** Result of PCMtoWav: the wrapped WAV plus the silence-trim window. */
export interface WavResult {
  file: fs.File;
  /** Trimmed window start in the original PCM timeline (microseconds). */
  trimStartUs: number;
  /** Trimmed window end in the original PCM timeline (microseconds). */
  trimEndUs: number;
  /** True when leading/trailing silence was actually removed. */
  trimmed: boolean;
}

export async function toWav(file: fs.File): Promise<fs.File> {
  try {
    // We transcode to high-bitrate AAC first to handle resampling/downmixing via Litr
    // if the source is not already compatible.
    const transcodedAudio = new fs.File(fs.Paths.cache, `denoised_${Date.now()}.m4a`);
    await extractAndTranscodeAudio(
      file.uri,
      transcodedAudio.uri,
      256000, // High bitrate for quality
    );

    // Then decode to PCM
    const { file: pcmFile, sampleRate } = await decodeToPCMFile(transcodedAudio);

    // Then wrap in WAV
    const wavFile = await PCMtoWav(pcmFile, sampleRate);
    return wavFile.file;
  } catch (error) {
    console.error("Failed to convert to WAV.", error);
    throw new Error(
      `WAV conversion failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function decodeToPCMFile(
  file: fs.File,
  outputUri?: string,
): Promise<{ file: fs.File; sampleRate: number }> {
  try {
    const outputFile = outputUri
      ? new fs.File(outputUri)
      : new fs.File(fs.Paths.cache, `denoised_${Date.now()}.pcm`);
    const result = await decodeToPCM(
      file.uri,
      outputFile.uri,
    );
    return { file: outputFile, sampleRate: result.sampleRate };
  } catch (error) {
    // MediaExtractor can fail to parse WAV files on some devices.
    // Fall back to direct RIFF/WAVE parsing for .wav files.
    if (/\.wav(\?|#|$)/i.test(file.uri)) {
      try {
        console.warn("MediaExtractor failed on WAV, trying direct extraction:", file.uri);
        const outputFile = outputUri
          ? new fs.File(outputUri)
          : new fs.File(fs.Paths.cache, `denoised_${Date.now()}.pcm`);
        const result = await extractWavAudio(file.uri, outputFile.uri);
        return { file: outputFile, sampleRate: result.sampleRate };
      } catch (wavError) {
        throw new Error(
          `PCM decoding failed: ${wavError instanceof Error ? wavError.message : String(wavError)}`,
        );
      }
    }
    throw new Error(
      `PCM decoding failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function PCMtoWav(
  file: fs.File,
  sampleRate: number = 48000,
  silenceTrim?: SilenceTrimSettings,
): Promise<WavResult> {
  const outputFile = new fs.File(fs.Paths.cache, `denoised_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    const result = await nativePcmToWav(file.uri, outputFile.uri, sampleRate, 1, 16,
      silenceTrim && silenceTrim.enabled ? trimToNativeConfig(silenceTrim) : null);
    return { file: outputFile, trimStartUs: result.trimStartUs, trimEndUs: result.trimEndUs, trimmed: result.trimmed };
  } catch (error) {
    try { if (outputFile.exists) outputFile.delete(); } catch { /* best effort */ }
    throw new Error(`WAV wrapping failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resample one complete buffer using the same streaming engine as file processing. */
export function resample(
  input: Int16Array | Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  const resampler = new StreamingResampler(inputRate, outputRate);
  const body = resampler.push(input);
  const tail = resampler.finish();
  const result = new Float32Array(body.length + tail.length);
  result.set(body);
  result.set(tail, body.length);
  return result;
}

export async function PCMtoArray(
  file: fs.File,
  inputRate?: number,
  targetRate?: number
): Promise<Float32Array> {
  if (!file.exists) throw new Error("File does not exist");

  const fileSize = file.size;
  if (fileSize % 2 !== 0) {
    throw new Error(`Invalid PCM data: Byte length (${fileSize}) is not divisible by 2.`);
  }

  const numSamples = fileSize / 2;
  const pcmArray = new Int16Array(numSamples);

  const handle = file.open();
  try {
    const chunkSize = 256 * 1024; // 256KB chunks
    for (let offset = 0; offset < fileSize; offset += chunkSize) {
      const length = Math.min(chunkSize, fileSize - offset);
      handle.offset = offset;
      const bytes = handle.readBytes(length);
      const chunk = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      pcmArray.set(chunk, offset / 2);
    }
  } finally {
    handle.close();
  }

  if (inputRate && targetRate && inputRate !== targetRate) {
    return resample(pcmArray, inputRate, targetRate);
  }

  // Convert to Float32Array
  const float32Array = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    float32Array[i] = pcmArray[i] / 32768.0;
  }
  return float32Array;
}

export async function readPCMChunks(
  file: fs.File,
  chunkSize: number, // in samples
  onChunk: (chunk: Float32Array, inputSamples: number) => Promise<void>,
  inputRate?: number,
  targetRate?: number,
): Promise<void> {
  if (!file.exists) throw new Error("File does not exist");
  const fileSize = file.size;
  if (fileSize % 2 !== 0) throw new Error("Invalid 16-bit PCM byte length.");
  const resampler = inputRate && targetRate && inputRate !== targetRate
    ? new StreamingResampler(inputRate, targetRate) : null;
  const handle = file.open();
  try {
    const bytesPerChunk = chunkSize * 2;
    for (let offset = 0; offset < fileSize; offset += bytesPerChunk) {
      const length = Math.min(bytesPerChunk, fileSize - offset);
      handle.offset = offset;
      const bytes = handle.readBytes(length);
      const pcmChunk = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      let floatChunk: Float32Array;
      if (resampler) {
        floatChunk = resampler.push(pcmChunk);
      } else {
        floatChunk = new Float32Array(pcmChunk.length);
        for (let i = 0; i < pcmChunk.length; i++) floatChunk[i] = pcmChunk[i] / 32768;
      }
      await onChunk(floatChunk, pcmChunk.length);
    }
    const tail = resampler?.finish();
    if (tail && tail.length) await onChunk(tail, 0);
  } finally {
    handle.close();
  }
}

export async function writePCMChunk(
  file: fs.File,
  chunk: Float32Array,
  append: boolean
): Promise<void> {
  const pcmChunk = new Int16Array(chunk.length);
  for (let j = 0; j < pcmChunk.length; j++) {
    if (!Number.isFinite(chunk[j])) throw new Error("Cannot write non-finite audio samples");
    let val = chunk[j] * 32768.0;
    if (val > 32767) val = 32767;
    else if (val < -32768) val = -32768;
    pcmChunk[j] = val;
  }

  // Write raw little-endian PCM bytes directly. The new expo-file-system
  // API writes Uint8Array without encoding, so we skip the base64 string
  // building that previously dominated the recording hot path.
  await file.write(new Uint8Array(pcmChunk.buffer), { append });
}

export async function ArraytoPCM(f32array: Float32Array): Promise<fs.File> {
  const outputFile = new fs.File(fs.Paths.cache, `processed_${Date.now()}.pcm`);

  // Process and write in chunks to avoid large intermediate buffers
  const chunkSize = 65536; // 64K samples = 128KB
  for (let i = 0; i < f32array.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, f32array.length);
    const pcmChunk = new Int16Array(end - i);

    for (let j = 0; j < pcmChunk.length; j++) {
      if (!Number.isFinite(f32array[i + j])) throw new Error("Cannot write non-finite audio samples");
      let val = f32array[i + j] * 32768.0;
      if (val > 32767) val = 32767;
      else if (val < -32768) val = -32768;
      pcmChunk[j] = val;
    }

    const bytes = new Uint8Array(pcmChunk.buffer);
    let binaryString = "";
    const step = 8192;
    for (let k = 0; k < bytes.length; k += step) {
      const end = Math.min(k + step, bytes.length);
      for (let i = k; i < end; i++) binaryString += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binaryString);

    await outputFile.write(base64, {
      encoding: "base64",
      append: i > 0,
    });
  }

  return outputFile;
}
export async function saveToDevice(file: fs.File, albumName = "DeepDenoiser"): Promise<boolean> {
  try {
    if (Platform.OS !== "android") throw new Error("Shared-media saving is supported on Android");
    const video = /\.mp4$/i.test(file.name);
    if (!video && !/\.wav$/i.test(file.name)) throw new Error("Unsupported output format");
    // Android 10+ can add our own files without broad media-read permission.
    // Android 8/9 still requires legacy write access.
    if (Number(Platform.Version) < 29) {
      const { status } = await requestPermissionsAsync(true, [video ? "video" : "audio"]);
      if (status !== "granted") return false;
    }
    await exportMediaFile(file.uri, file.name, albumName, video);
    trackAppEvent("save_file");
    return true;
  } catch (e) {
    console.error("Failed to save file to device:", e);
    return false;
  }
}
export async function mergeAudioVideo(
  video: fs.File,
  audio: fs.File,
  trim?: { startUs: number; endUs: number; trimmed: boolean },
): Promise<fs.File> {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const transcodedAudio = new fs.File(fs.Paths.cache, `denoised_${id}.m4a`);
  const outputFile = new fs.File(fs.Paths.cache, `denoised_${id}.mp4`);
  let success = false;
  try {
    await extractAndTranscodeAudio(audio.uri, transcodedAudio.uri.replace("file://", ""), 128000);
    await mixAudioVideo(video.uri, transcodedAudio.uri, outputFile.uri.replace("file://", ""),
      trim && trim.trimmed ? { enabled: true, startUs: trim.startUs, endUs: trim.endUs } : undefined);
    success = true;
    return outputFile;
  } catch (error) {
    throw new Error(`Merge failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { if (transcodedAudio.exists) transcodedAudio.delete(); } catch { /* best effort */ }
    if (!success) try { if (outputFile.exists) outputFile.delete(); } catch { /* best effort */ }
  }
}

export function sanitizeFileName(name: string): string {
  return name
    .replaceAll(ILLEGAL_FS_CHARS, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .trim() || 'denoised';
}

export function renameFile(file: fs.File, newName: string): fs.File {
  const safeName = sanitizeFileName(newName);
  const checkPath = new fs.File(fs.Paths.cache, encodeURIComponent(safeName));
  if (checkPath.exists) checkPath.delete();
  file.rename(safeName);
  return file;
}
