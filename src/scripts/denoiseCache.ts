import metadata from "@/assets/model/model_metadata.json";
import { atomicReplaceFile, copyFileWithSha256, fingerprintFile, linkPrivateFileNoReplace } from "@/modules/AudioProcessorModule";
import * as fs from "expo-file-system";
import { isProcessingMedia } from "./denoiserSingleton";
import { sanitizeFileName } from "./formatHandler";
import type { MediaKind } from "./mediaSelection";

/** Private, persistent storage for imported media and finished outputs. */
const IMPORTS_DIR_NAME = "imports";
const IMPORT_METADATA_DIR_NAME = "import_metadata";
const OUTPUTS_DIR_NAME = "denoised";
const INDEX_FILE_NAME = "denoiser_cache.json";
const DECODE_INDEX_NAME = "decode_cache.json";
const DENOISE_INDEX_NAME = "denoise_cache.json";
const MAX_CACHED_OUTPUTS = 100;
const MAX_CACHED_DECODES = 5;
const MAX_CACHED_DENOISES = 8;
// Each rebuildable PCM group is limited separately. Durable files are never pruned.
const MAX_PCM_STAGE_BYTES = 512 * 1024 * 1024;
/** Bump when decoded samples, the model, input framing or resampler changes. */
const PIPELINE_VERSION = "dfn3-v5-signed-wav";

interface CacheEntry { path: string; createdAt: number; bytes?: number; sha256?: string }
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

// Never reuse a temporary name within this JS process, even if a failed native
// copy has already removed it and random/time values happen to collide.
let tempSequence = 0;
/** Reserve a private temporary name without ever truncating another file. */
export function reservePrivateTemp(dir: fs.Directory, prefix: string): fs.File {
  const ticket = ++tempSequence;
  for (let attempt = 0; attempt < 32; attempt++) {
    const file = new fs.File(dir, `${prefix}${uniqueSuffix()}_${ticket}_${attempt}.tmp`);
    try { file.create(); return file; }
    catch (error) { if (!file.exists) throw error; }
  }
  throw new Error("Could not reserve a private temporary file.");
}

/**
 * Verify both the incoming private copy and any pre-existing digest-named
 * destination. Publish via an atomic no-replace link; a competing import is
 * verified too. A damaged earlier copy is left intact under its old name.
 */
export async function importToDocuments(
  sourceUri: string,
  name: string,
  fallbackUri?: string,
  kind?: MediaKind,
  onDamagedExistingCopy?: () => void,
): Promise<fs.File> {
  const dir = importsDir();
  let pending = reservePrivateTemp(dir, "_pending_");
  const reservedUris = [pending.uri];
  try {
    let digest: string;
    try {
      digest = await copyFileWithSha256(normalizeFileUri(sourceUri), pending.uri);
    } catch (primaryError) {
      if (!fallbackUri) throw primaryError;
      // Native copy removes its partial destination on failure. Reserve a new
      // name rather than recreating an unowned path for the fallback.
      pending = reservePrivateTemp(dir, "_pending_");
      reservedUris.push(pending.uri);
      digest = await copyFileWithSha256(normalizeFileUri(fallbackUri), pending.uri);
    }
    if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("Could not verify imported file.");
    digest = digest.toLowerCase();
    const incoming = await checkedFingerprint(pending);
    if (incoming.sha256 !== digest) throw new Error("The imported copy failed integrity verification; the source was not changed.");

    const safe = safeName(name);
    const dot = safe.lastIndexOf(".");
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    let damagedCanonical = false;
    let dest: fs.File | null = null;
    for (let attempt = 0; attempt < 64; attempt++) {
      const suffix = attempt === 0 ? "" : attempt === 1 ? "_verified" : `_verified_${uniqueSuffix()}_${attempt}`;
      // Android's usual filename limit is 255 bytes; safeName is ASCII.
      const baseLimit = Math.max(1, 255 - digest.length - 1 - suffix.length - ext.length);
      const candidate = new fs.File(dir, `${digest}_${base.slice(0, baseLimit)}${suffix}${ext}`);
      if (!candidate.exists) {
        // This link either publishes the already-verified bytes or leaves the
        // other winner untouched; the source remains until finally below.
        if (await linkPrivateFileNoReplace(pending.uri, candidate.uri)) {
          dest = candidate;
          break;
        }
      }
      // A file may have appeared between exists and link, or been corrupted
      // since a previous import. Never trust a filename as an integrity proof.
      try {
        const existing = await checkedFingerprint(candidate);
        if (existing.bytes === incoming.bytes && existing.sha256 === digest) {
          dest = candidate;
          break;
        }
      } catch { /* unreadable or changing: keep it and use another name */ }
      if (attempt === 0) damagedCanonical = true;
    }
    if (!dest) throw new Error("Could not allocate a separate verified import. The incoming source was not changed.");
    if (damagedCanonical) {
      try { onDamagedExistingCopy?.(); } catch (error) { console.warn("Import warning observer failed:", error); }
    }
    if (kind) {
      try { await setImportedMediaKind(dest, kind, true); }
      catch (error) { console.warn("Could not save imported media type:", error); }
    }
    return dest;
  } finally {
    // The reserved path is ours; any successful link remains under dest.
    for (const uri of reservedUris) {
      const leftover = new fs.File(uri);
      if (leftover.exists) {
        try { leftover.delete(); } catch { /* best effort */ }
      }
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

/** Sidecars live outside imports, so discovery never treats metadata as media. */
function importedKindFile(file: fs.File): fs.File | null {
  const expected = new fs.File(fs.Paths.document, IMPORTS_DIR_NAME, file.name);
  if (normalizeFileUri(file.uri) !== normalizeFileUri(expected.uri)) return null;
  return new fs.File(fs.Paths.document, IMPORT_METADATA_DIR_NAME, `${file.name}.kind.json`);
}

/** A missing, unreadable or invalid sidecar is explicitly unknown, never guessed. */
export function readImportedMediaKind(file: fs.File): MediaKind | null {
  try {
    const metadataFile = importedKindFile(file);
    if (!metadataFile?.exists) return null;
    const parsed: unknown = JSON.parse(metadataFile.textSync());
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { version?: unknown; kind?: unknown };
    return record.version === 1 && (record.kind === "audio" || record.kind === "video") ? record.kind : null;
  } catch { return null; }
}

/** Atomically persist an explicit classification, without changing media bytes. */
export function setImportedMediaKind(file: fs.File, kind: MediaKind, onlyIfMissing = false): Promise<void> {
  const target = importedKindFile(file);
  if (!target || (kind !== "audio" && kind !== "video")) return Promise.reject(new Error("Invalid imported media type."));
  return withIndexLock(`kind:${target.uri}`, async () => {
    if (!file.exists) throw new Error("The imported file is no longer available.");
    if (onlyIfMissing && readImportedMediaKind(file)) return;
    const directory = new fs.Directory(fs.Paths.document, IMPORT_METADATA_DIR_NAME);
    if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
    const temp = new fs.File(directory, `${uniqueSuffix()}.tmp`);
    try {
      await temp.write(JSON.stringify({ version: 1, kind }), { encoding: "utf8" });
      await atomicReplaceFile(temp.uri, target.uri);
    } finally {
      if (temp.exists) { try { temp.delete(); } catch { /* best effort */ } }
    }
  });
}

/** Delete a sidecar only after its corresponding import has been deleted. */
export function removeImportedMediaKind(file: fs.File): void {
  try {
    const sidecar = importedKindFile(file);
    if (sidecar?.exists) sidecar.delete();
  } catch (error) { console.warn("Could not remove imported media metadata:", error); }
}

type StagePrefix = "stage_dec" | "stage_dn";

/** Only named, direct children of the app cache are disposable PCM stages. */
function rebuildableStage(path: unknown, prefix: StagePrefix): fs.File | null {
  if (typeof path !== "string") return null;
  try {
    const file = new fs.File(path);
    if (!new RegExp(`^${prefix}_\\d+_[a-z0-9]+\\.pcm$`).test(file.name)) return null;
    const expected = new fs.File(fs.Paths.cache, file.name);
    return normalizeFileUri(file.uri) === normalizeFileUri(expected.uri) ? file : null;
  } catch { return null; }
}

type Fingerprint = { bytes: number; sha256: string };

/** Hash on the native IO dispatcher and reject a changing or malformed file. */
async function checkedFingerprint(file: fs.File, pcm = false): Promise<Fingerprint> {
  const initialSize = file.size;
  if (!file.exists || !Number.isSafeInteger(initialSize) || initialSize <= 0 ||
      (pcm && (initialSize % 2 !== 0 || initialSize > 0xffffffff - 36))) {
    throw new Error("Invalid or incomplete cache file.");
  }
  const fingerprint = await fingerprintFile(file.uri);
  if (!fingerprint || !Number.isSafeInteger(fingerprint.bytes) || fingerprint.bytes !== initialSize ||
      !/^[a-f0-9]{64}$/i.test(fingerprint.sha256) || !file.exists || file.size !== initialSize) {
    throw new Error("File changed during integrity verification.");
  }
  return { bytes: fingerprint.bytes, sha256: fingerprint.sha256.toLowerCase() };
}

async function matchesFingerprint(file: fs.File, entry: CacheEntry, pcm = false): Promise<boolean> {
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== file.size ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) return false;
  try {
    const current = await checkedFingerprint(file, pcm);
    return current.bytes === entry.bytes && current.sha256 === entry.sha256.toLowerCase();
  } catch { return false; }
}

function pruneOldest<T extends CacheEntry>(index: Record<string, T>, max: number): void {
  const keys = Object.keys(index);
  if (keys.length <= max) return;
  const oldest = keys.sort((a, b) => index[a].createdAt - index[b].createdAt).slice(0, keys.length - max);
  // This is only for finished-output metadata; never delete the user's media.
  for (const key of oldest) delete index[key];
}

/** Remove oldest verified-path stage files by both count and bytes, only while idle. */
function pruneStageIndex<T extends CacheEntry>(index: Record<string, T>, maxCount: number, prefix: StagePrefix): boolean {
  if (isProcessingMedia()) return false;
  const keys = Object.keys(index).sort((a, b) => (index[a]?.createdAt || 0) - (index[b]?.createdAt || 0));
  const files = new Map<string, fs.File>();
  for (const key of keys) {
    const file = rebuildableStage(index[key]?.path, prefix);
    if (file?.exists) files.set(file.uri, file);
  }
  let bytes = [...files.values()].reduce((sum, file) => sum + file.size, 0);
  let count = keys.length;
  let changed = false;
  for (const key of keys) {
    if (count <= maxCount && bytes <= MAX_PCM_STAGE_BYTES) break;
    const file = rebuildableStage(index[key]?.path, prefix);
    const otherReference = file && Object.entries(index).some(([other, entry]) => other !== key && entry?.path === index[key]?.path);
    if (file?.exists && !otherReference) {
      try {
        const size = file.size;
        file.delete();
        if (file.exists) continue;
        bytes -= size;
      } catch (error) { console.warn("Could not prune old PCM cache:", error); continue; }
    }
    delete index[key];
    count--;
    changed = true;
  }
  return changed;
}

/** Limit only rebuildable stages, and never prune while a recording/job uses them. */
export async function pruneRebuildableCache(): Promise<void> {
  const groups: [string, StagePrefix, number][] = [
    [DECODE_INDEX_NAME, "stage_dec", MAX_CACHED_DECODES],
    [DENOISE_INDEX_NAME, "stage_dn", MAX_CACHED_DENOISES],
  ];
  for (const [name, prefix, maxCount] of groups) {
    await withIndexLock(name, async () => {
      const index = await readJsonIndex<CacheEntry>(name);
      // No asynchronous operation occurs between this check and deletion.
      if (isProcessingMedia()) return;
      if (pruneStageIndex(index, maxCount, prefix)) await writeJsonIndex(name, index);
    });
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
  kind: MediaKind,
): string {
  return [
    "out-v3-kind", PIPELINE_VERSION, `${metadata.hop_size}-${metadata.fft_size}`,
    kind, buildInputIdentity(input), settings.attenLimDb, settings.normalize.toggle,
    settings.normalize.targetRMS, settings.normalize.maxPeakDb,
    settings.silenceTrim.enabled, settings.silenceTrim.mode,
    settings.silenceTrim.thresholdDb, settings.silenceTrim.minSilenceMs,
  ].join("|");
}

export function buildDecodeKey(input: fs.File): string {
  // Older direct-WAV fallback decodes could contain unsigned PCM16 samples.
  // The index did not record which decoder was used, so miss old PCM entries
  // rather than risk reusing damaged data. Durable user outputs are untouched.
  return ["dec-v4-signed-wav", buildInputIdentity(input)].join("|");
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

export function lookupCachedOutput(key: string, kind: MediaKind): Promise<fs.File | null> {
  return withIndexLock(INDEX_FILE_NAME, async () => {
    const index = await readJsonIndex<CacheEntry>(INDEX_FILE_NAME);
    const entry = index[key];
    if (!entry) return null;
    try {
      if (typeof entry.path === "string") {
        const file = new fs.File(entry.path);
        const expectedExtension = kind === "video" ? /\.mp4$/i : /\.wav$/i;
        const expectedLocation = new fs.File(fs.Paths.document, OUTPUTS_DIR_NAME, file.name);
        if (file.exists && expectedExtension.test(file.name) &&
            normalizeFileUri(file.uri) === normalizeFileUri(expectedLocation.uri) &&
            await matchesFingerprint(file, entry)) return file;
      }
    } catch { /* Discard a malformed entry, not the media it might reference. */ }
    delete index[key];
    await writeJsonIndex(INDEX_FILE_NAME, index);
    return null;
  });
}

export function storeCachedOutput(key: string, file: fs.File): Promise<void> {
  return withIndexLock(INDEX_FILE_NAME, async () => {
    const index: CacheIndex = await readJsonIndex(INDEX_FILE_NAME);
    const fingerprint = await checkedFingerprint(file);
    index[key] = { path: file.uri, createdAt: Date.now(), ...fingerprint };
    // Finished output is the user's media, not disposable cache data.
    pruneOldest(index, MAX_CACHED_OUTPUTS);
    await writeJsonIndex(INDEX_FILE_NAME, index);
  });
}

export function lookupDecodedPCM(key: string): Promise<{ file: fs.File; sampleRate: number } | null> {
  return withIndexLock(DECODE_INDEX_NAME, async () => {
    const index = await readJsonIndex<DecodeEntry>(DECODE_INDEX_NAME);
    const entry = index[key];
    if (!entry) return null;
    const file = rebuildableStage(entry.path, "stage_dec");
    try {
      if (file?.exists && Number.isFinite(entry.sampleRate) && entry.sampleRate > 0 &&
          await matchesFingerprint(file, entry, true)) return { file, sampleRate: entry.sampleRate };
    } catch { /* Invalid cache entries are never grounds to delete other files. */ }
    delete index[key];
    await writeJsonIndex(DECODE_INDEX_NAME, index);
    return null;
  });
}

export function storeDecodedPCM(key: string, file: fs.File, sampleRate: number): Promise<void> {
  return withIndexLock(DECODE_INDEX_NAME, async () => {
    const index = await readJsonIndex<DecodeEntry>(DECODE_INDEX_NAME);
    if (!rebuildableStage(file.uri, "stage_dec") || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error("Invalid decoded PCM cache entry.");
    }
    const fingerprint = await checkedFingerprint(file, true);
    index[key] = { path: file.uri, sampleRate, createdAt: Date.now(), ...fingerprint };
    await writeJsonIndex(DECODE_INDEX_NAME, index);
  });
}

export function lookupDenoisedPCM(key: string): Promise<fs.File | null> {
  return withIndexLock(DENOISE_INDEX_NAME, async () => {
    const index = await readJsonIndex<DenoiseEntry>(DENOISE_INDEX_NAME);
    const entry = index[key];
    if (!entry) return null;
    const file = rebuildableStage(entry.path, "stage_dn");
    try { if (file?.exists && await matchesFingerprint(file, entry, true)) return file; }
    catch { /* Discard only the bad index entry. */ }
    delete index[key];
    await writeJsonIndex(DENOISE_INDEX_NAME, index);
    return null;
  });
}

export function storeDenoisedPCM(key: string, file: fs.File): Promise<void> {
  return withIndexLock(DENOISE_INDEX_NAME, async () => {
    const index = await readJsonIndex<DenoiseEntry>(DENOISE_INDEX_NAME);
    if (!rebuildableStage(file.uri, "stage_dn")) throw new Error("Invalid denoised PCM cache entry.");
    const fingerprint = await checkedFingerprint(file, true);
    index[key] = { path: file.uri, createdAt: Date.now(), ...fingerprint };
    await writeJsonIndex(DENOISE_INDEX_NAME, index);
  });
}

/** Size of indexed, verified, rebuildable PCM; this excludes every durable file. */
export async function getRebuildableCacheBytes(): Promise<number> {
  const groups: [string, StagePrefix][] = [[DECODE_INDEX_NAME, "stage_dec"], [DENOISE_INDEX_NAME, "stage_dn"]];
  const files = new Map<string, number>();
  await Promise.all(groups.map(([indexName, prefix]) => withIndexLock(indexName, async () => {
    const index = await readJsonIndex<CacheEntry>(indexName);
    for (const entry of Object.values(index)) {
      const file = rebuildableStage(entry?.path, prefix);
      if (file?.exists) files.set(file.uri, Math.max(0, file.size));
    }
  })));
  return [...files.values()].reduce((sum, size) => sum + size, 0);
}

/**
 * Remove only indexed PCM stages and their entries. Recheck safety inside each
 * index lock, after asynchronous reads, so processing cannot start in between.
 * Recordings, original backups, imports and finished results are never swept.
 */
export async function clearRebuildableCache(assertSafe: () => void): Promise<void> {
  const groups: [string, StagePrefix][] = [[DECODE_INDEX_NAME, "stage_dec"], [DENOISE_INDEX_NAME, "stage_dn"]];
  for (const [indexName, prefix] of groups) {
    await withIndexLock(indexName, async () => {
      const index = await readJsonIndex<CacheEntry>(indexName);
      assertSafe();
      let changed = false;
      let failures = 0;
      for (const [key, entry] of Object.entries(index)) {
        const file = rebuildableStage(entry?.path, prefix);
        if (!file) continue;
        try {
          if (file.exists) file.delete();
          if (file.exists) { failures++; continue; }
          delete index[key];
          changed = true;
        } catch { failures++; }
      }
      if (changed) await writeJsonIndex(indexName, index);
      if (failures) throw new Error("Some temporary files could not be cleared. Try again.");
    });
  }
}

/** Remove old unindexed scratch, but never sweep streamed original backups or finished media. */
export async function cleanupTempCache(): Promise<void> {
  try {
    if (isProcessingMedia()) return;
    await pruneRebuildableCache();
    const decode = await withIndexLock(DECODE_INDEX_NAME, () => readJsonIndex<DecodeEntry>(DECODE_INDEX_NAME));
    const denoise = await withIndexLock(DENOISE_INDEX_NAME, () => readJsonIndex<DenoiseEntry>(DENOISE_INDEX_NAME));
    if (isProcessingMedia()) return;
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
