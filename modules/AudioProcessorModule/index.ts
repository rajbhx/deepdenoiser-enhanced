// Reexport the native module. On web, it will be resolved to AudioProcessorModule.web.ts
// and on native platforms to AudioProcessorModule.ts
// export { default } from "./src/AudioProcessorModule";
import AudioProcessorModule from "./src/AudioProcessorModule";
import type { PcmToWavResult, SilenceTrimNativeConfig, VideoTrimConfig } from "./src/AudioProcessorModule.types";
export * from "./src/AudioProcessorModule.types";

export async function extractAndTranscodeAudio(
  inputUri: string,
  outputUri: string,
  bitrate?: number,
): Promise<string> {
  return await AudioProcessorModule.extractAndTranscodeAudio(
    inputUri,
    outputUri,
    bitrate,
  );
}

export async function mixAudioVideo(
  videoUri: string,
  audioUri: string,
  outputUri: string,
  trim?: VideoTrimConfig,
): Promise<string> {
  return await AudioProcessorModule.mixAudioVideo(
    videoUri,
    audioUri,
    outputUri,
    trim ?? null,
  );
}

export async function decodeToPCM(
  inputUri: string,
  outputUri: string,
): Promise<{ path: string; sampleRate: number }> {
  return await AudioProcessorModule.decodeToPCM(inputUri, outputUri);
}

export async function extractWavAudio(
  inputUri: string,
  outputUri: string,
): Promise<{ path: string; sampleRate: number }> {
  return await AudioProcessorModule.extractWavAudio(inputUri, outputUri);
}

export async function pcmToWav(
  pcmUri: string,
  wavUri: string,
  sampleRate: number = 48000,
  channels: number = 1,
  bitDepth: number = 16,
  silenceTrim?: SilenceTrimNativeConfig | null,
): Promise<PcmToWavResult> {
  return await AudioProcessorModule.pcmToWav(
    pcmUri,
    wavUri,
    sampleRate,
    channels,
    bitDepth,
    silenceTrim ?? null,
  );
}

export async function copyFile(
  sourceUri: string,
  destUri: string,
): Promise<string> {
  return await AudioProcessorModule.copyFile(sourceUri, destUri);
}

/** Copy a file and calculate its SHA-256 without bringing its bytes into JS. */
export async function copyFileWithSha256(sourceUri: string, destUri: string): Promise<string> {
  return AudioProcessorModule.copyFileWithSha256(sourceUri, destUri);
}

export async function getFileSize(path: string): Promise<number> {
  return await AudioProcessorModule.getFileSize(path);
}

/** Atomically replace a local private file, preserving the old file on failure. */
export async function atomicReplaceFile(sourceUri: string, targetUri: string): Promise<string> {
  return await AudioProcessorModule.atomicReplaceFile(sourceUri, targetUri);
}

/** Save app-created media into the appropriate Android shared collection. */
export async function exportMediaFile(sourceUri: string, filename: string, album: string, video: boolean): Promise<string> {
  return await AudioProcessorModule.exportMediaFile(sourceUri, filename, album, video);
}
