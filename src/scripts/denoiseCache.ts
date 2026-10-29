import metadata from "@/assets/model/model_metadata.json";
import { atomicReplaceFile, copyFileWithSha256 } from "@/modules/AudioProcessorModule";
import * as fs from "expo-file-system";
import { sanitizeFileName } from "./formatHandler";

/** Private, persistent storage for imported media and finished outputs. */
const IMPORTS_DIR_NAME = "imports";
const OUTPUTS_DIR_NAME = "denoised";
const INDEX_FILE_NAME = "denoiser_cache.json";
const DECODE_INDEX_NAME = "decode_cache.json";
const DENOISE_INDEX_NAME = "denoise_cache.json";
const MAX_CACHED_OUTPUTS = 100;
const MAX_CACHED_DECODES = 5;
const MAX_CACHED_DENOISES = 8;
/** Bump when the model, input framing or resampler changes. */
const PIPELINE_VERSION = "dfn3-v3-aligned-normalized-mix";

interface CacheEntry { path: string; createdAt: number }
interface DecodeEntry extends CacheEntry { sampleRate: number }
type DenoiseEntry = CacheEntry;
type CacheIndex = Record<string, CacheEntry>;

export function importsDir(): fs.Directory {
  const dir = new fs.Directory(fs.Paths.document, IMPORTS_DIR_NAME);
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  return dir;
}

export function outputDir(): fs.Directory {
  const dir = new fs.Directory(fs.Paths.document, OUTPUTS_DIR_NAME);
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  return dir;
}

function normalizeFileUri(uri: string): string {
  if (uri.startsWith("file:/") && !uri.startsWith("file:///")) {
    return "file:///" + uri.slice("file:/".length);
  }
  return uri;
}

function safeName(name: string, limit = 170): string {
  const safe = sanitizeFileName(name || "import");
  const dot = safe.lastIndexOf(".");
  const ext = dot > 0 ? safe.slice(dot, dot + 16) : "";
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  return `${base.slice(0, Math.max(1, limit - ext.length))}${ext}`;
}

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Copy and hash the entire source in native streaming code. The temporary file
 * is never promoted until the copy succeeds. Identical bytes + names reuse an
 * immutable import; same-name/same-size *different* media cannot collide.
 */
export async function importToDocuments(
  sourceUri: string,
  name: string,
  fallbackUri?: string,
): Promise<fs.File> {
  const dir = importsDir();
  const pendingName = `_pending_${uniqueSuffix()}.tmp`;
  const pending = new fs.File(dir, pendingName);
  try {
    let digest: string;
    try {
      digest = await copyFileWithSha256(normalizeFileUri(sourceUri), pending.uri);
    } catch (primaryError) {
      if (!fallbackUri) throw primaryError;
      // Native code removes partial files before rejecting.
      digest = await copyFileWithSha256(normalizeFileUri(fallbackUri), pending.uri);
    }
    if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("Could not verify imported file.");
    const dest = new fs.File(dir, `${digest.toLowerCase()}_${safeName(name)}`);
    if (dest.exists) return dest;
    try {
      await pending.move(dest);
    } catch (error) {
      // A concurrent import of the same digest can win the move.
      if (!dest.exists) throw error;
    }
    return dest;
  } finally {
    // After move(), pending.uri points at dest; never delete a promoted file.
    // Check against the original pending name instead of the mutable File URI.
    const leftover = new fs.File(dir, pendingName);
    if (leftover.exists) {
      try { leftover.delete(); } catch { /* best effort */ }
    }
  }
}

/** Allocate a non-overwriting output name, even for inputs with identical names. */
function newOutput(name: string): fs.File {
  const safe = safeName(name, 190);
  let dest = new fs.File(outputDir(), safe);
  if (dest.exists) {
    const dot = safe.lastIndexOf(".");
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    dest = new fs.File(outputDir(), `${base}_${uniqueSuffix()}${ext}`);
  }
  return dest;
}

/** Finished media is persistent and never overwritten or deleted by cache pruning. */
export async function placeOutput(source: fs.File, name: string): Promise<fs.File> {
  const dest = newOutput(name);
  await source.move(dest);
  return dest;
}

/** Copy an externally owned recording to durable storage without removing its source. */
export async function copyOutput(source: fs.File, name: string): Promise<fs.File> {
  const dest = newOutput(name);
  await source.copy(dest);
  return dest;
}

// The app has a single JS runtime, so a per-index promise queue serializes
// every read/modify/write. A temp-file move keeps the previous index intact if
// JSON writing fails. A rejected mutation never poisons the queue.
const indexLocks = new Map<string, Promise<void>>();
function withIndexLock<T>(fileName: string, work: () => Promise<T>): Promise<T> {
  const previous = indexLocks.get(fileName) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(() => undefined, () => undefined);
  indexLocks.set(fileName, settled);
  void settled.then(() => {
    if (indexLocks.get(fileName) === settled) indexLocks.delete(fileName);
  });
  return result;
}

async function readJsonIndex<T>(fileName: string): Promise<Record<string, T>> {
  try {
    const file = new fs.File(fs.Paths.document, fileName);
    if (!file.exists) return {};
    const raw = await file.text();
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, T> : {};
  } catch (error) {
    console.warn(`Could not read cache index ${fileName}:`, error);
    return {};
  }
}

async function writeJsonIndex<T>(fileName: string, index: Record<string, T>): Promise<void> {
  const temp = new fs.File(fs.Paths.document, `${fileName}.${uniqueSuffix()}.tmp`);
  const target = new fs.File(fs.Paths.document, fileName);
  try {
    await temp.write(JSON.stringify(index), { encoding: "utf8" });
    await atomicReplaceFile(temp.uri, target.uri);
  } finally {
    // Only the temporary path may be cleaned; the old/new index is never deleted.
    if (temp.name.endsWith(".tmp") && temp.exists) {
      try { temp.delete(); } catch { /* best effort */ }
    }
  }
}

function pruneOldest<T extends CacheEntry>(index: Record<string, T>, max: number, deleteFiles: boolean): void {
  const keys = Object.keys(index);
  if (keys.length <= max) return;
  const oldest = keys.sort((a, b) => index[a].createdAt - index[b].createdAt).slice(0, keys.length - max);
  for (const key of oldest) {
    if (deleteFiles && index[key]?.path) {
      try {
        const file = new fs.File(index[key].path);
        if (file.exists) file.delete();
      } catch (error) { console.warn("Failed to delete old PCM cache:", error); }
    }
    delete index[key];
  }
}

/** Identity includes immutable SHA-256 import path; legacy/external paths also include URI and mtime. */
export function buildInputIdentity(input: fs.File): string {
  return ["input-v2", input.uri, input.size, input.modificationTime ?? "unknown"].join("|");
}

export function buildCacheKey(
  input: fs.File,
  settings: {
    attenLimDb: number;
    normalize: { toggle: boolean; targetRMS: number; maxPeakDb: number };
    silenceTrim: { enabled: boolean; mode: string; thresholdDb: number; minSilenceMs: number };
  },
): string {
  return [
    "out-v2", PIPELINE_VERSION, `${metadata.hop_size}-${metadata.fft_size}`,
    buildInputIdentity(input), settings.attenLimDb, settings.normalize.toggle,
    settings.normalize.targetRMS, settings.normalize.maxPeakDb,
    settings.silenceTrim.enabled, settings.silenceTrim.mode,
    settings.silenceTrim.thresholdDb, settings.silenceTrim.minSilenceMs,
  ].join("|");
}

export function buildDecodeKey(input: fs.File): string {
  return ["dec-v3-full-eos", buildInputIdentity(input)].join("|");
}

export function buildDenoiseKey(
  input: fs.File,
  settings: { attenLimDb: number; normalize: { toggle: boolean; targetRMS: number; maxPeakDb: number } },
): string {
  return ["dn-v2", PIPELINE_VERSION, buildInputIdentity(input), settings.attenLimDb,
    settings.normalize.toggle, settings.normalize.targetRMS, settings.normalize.maxPeakDb].join("|");
}

export function stagePcmPath(prefix: "stage_dec" | "stage_dn"): string {
  return `${prefix}_${uniqueSuffix()}.pcm`;
}

export function lookupCachedOutput(key: string): Promise<fs.File | null> {
  return withIndexLock(INDEX_FILE_NAME, async () => {
    const index = await readJsonIndex<CacheEntry>(INDEX_FILE_NAME);
    const entry = index[key];
    if (!entry) return null;
    const file = new fs.File(entry.path);
    if (file.exists) return file;
    delete index[key];
    await writeJsonIndex(INDEX_FILE_NAME, index);
    return null;
  });
}

export function storeCachedOutput(key: string, file: fs.File): Promise<void> {
  return withIndexLock(INDEX_FILE_NAME, async () => {
    const index: CacheIndex = await readJsonIndex(INDEX_FILE_NAME);
    index[key] = { path: file.uri, createdAt: Date.now() };
    // Finished output is the user's media, not disposable cache data.
    pruneOldest(index, MAX_CACHED_OUTPUTS, false);
    await writeJsonIndex(INDEX_FILE_NAME, index);
  });
}

export function lookupDecodedPCM(key: string): Promise<{ file: fs.File; sampleRate: number } | null> {
  return withIndexLock(DECODE_INDEX_NAME, async () => {
    const index = await readJsonIndex<DecodeEntry>(DECODE_INDEX_NAME);
    const entry = index[key];
    if (!entry) return null;
    const file = new fs.File(entry.path);
    if (file.exists) return { file, sampleRate: entry.sampleRate };
    delete index[key];
    await writeJsonIndex(DECODE_INDEX_NAME, index);
    return null;
  });
}

export function storeDecodedPCM(key: string, file: fs.File, sampleRate: number): Promise<void> {
  return withIndexLock(DECODE_INDEX_NAME, async () => {
    const index = await readJsonIndex<DecodeEntry>(DECODE_INDEX_NAME);
    index[key] = { path: file.uri, sampleRate, createdAt: Date.now() };
    pruneOldest(index, MAX_CACHED_DECODES, true);
    await writeJsonIndex(DECODE_INDEX_NAME, index);
  });
}

export function lookupDenoisedPCM(key: string): Promise<fs.File | null> {
  return withIndexLock(DENOISE_INDEX_NAME, async () => {
    const index = await readJsonIndex<DenoiseEntry>(DENOISE_INDEX_NAME);
    const entry = index[key];
    if (!entry) return null;
    const file = new fs.File(entry.path);
    if (file.exists) return file;
    delete index[key];
    await writeJsonIndex(DENOISE_INDEX_NAME, index);
    return null;
  });
}

export function storeDenoisedPCM(key: string, file: fs.File): Promise<void> {
  return withIndexLock(DENOISE_INDEX_NAME, async () => {
    const index = await readJsonIndex<DenoiseEntry>(DENOISE_INDEX_NAME);
    index[key] = { path: file.uri, createdAt: Date.now() };
    pruneOldest(index, MAX_CACHED_DENOISES, true);
    await writeJsonIndex(DENOISE_INDEX_NAME, index);
  });
}

/** Remove old unindexed scratch, but never sweep streamed original backups or finished media. */
export async function cleanupTempCache(): Promise<void> {
  try {
    const decode = await withIndexLock(DECODE_INDEX_NAME, () => readJsonIndex<DecodeEntry>(DECODE_INDEX_NAME));
    const denoise = await withIndexLock(DENOISE_INDEX_NAME, () => readJsonIndex<DenoiseEntry>(DENOISE_INDEX_NAME));
    const protectedPaths = new Set([...Object.values(decode), ...Object.values(denoise)].map((e) => e.path));
    const cache = new fs.Directory(fs.Paths.cache);
    if (!cache.exists) return;
    const olderThan = Date.now() - 24 * 60 * 60 * 1000;
    const patterns = [/^den_\d+\.pcm$/, /^processed_\d+\.pcm$/,
      /^stage_(dec|dn)_\d+_[a-z0-9]+\.pcm$/, /^remux_\d+\.mp4$/];
    for (const entry of cache.list()) {
      if (entry instanceof fs.Directory || protectedPaths.has(entry.uri)) continue;
      if (!entry.modificationTime || entry.modificationTime > olderThan) continue;
      if (patterns.some((pattern) => pattern.test(entry.name))) {
        try { entry.delete(); } catch (error) { console.warn("Could not remove old scratch file:", error); }
      }
    }
  } catch (error) { console.warn("Could not clean scratch files:", error); }
}
