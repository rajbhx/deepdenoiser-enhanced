import { getContentDisplayName } from "@/modules/AudioProcessorModule";
import type { SharePayload } from "expo-sharing";
import { importToDocuments, readImportedMediaKind } from "./denoiseCache";
import { MAX_BATCH_FILES, mediaKind, type MediaKind, type SelectedMedia } from "./mediaSelection";

const mediaExtension = /\.(aac|aif|aiff|alac|amr|caf|flac|m4a|mp3|ogg|opus|wav|wma|mp4|mov|mkv|avi|m4v|webm|3gp|mpeg|mpg|ts)$/i;

async function describePayload(payload: SharePayload, index: number): Promise<{ uri: string; name: string; kind: MediaKind }> {
  const uri = payload.value;
  const mime = (payload.mimeType || "").toLowerCase();
  if (!uri || !/^(content|file):\/\//i.test(uri)) {
    throw new Error(`Shared item ${index + 1} is not an accessible local file. Please share the audio or video file itself.`);
  }
  if (payload.shareType === "text" || payload.shareType === "url" || payload.shareType === "image") {
    throw new Error(`Shared item ${index + 1} is not audio or video. Please select only media files.`);
  }
  // This queries OpenableColumns only; it does not copy or modify the source.
  let name = "";
  try { name = await getContentDisplayName(uri); } catch { /* name is optional */ }
  if (!name) {
    try { name = decodeURIComponent(uri.split("?")[0]).split("/").pop() || ""; } catch { /* use generic name */ }
  }
  name = name.trim() || `shared_${index + 1}`;
  const mediaMime = mime.startsWith("audio/") || mime.startsWith("video/");
  const genericMime = !mime || mime === "*/*" || mime === "application/octet-stream";
  if (!mediaMime && payload.shareType !== "audio" && payload.shareType !== "video" && !(genericMime && mediaExtension.test(name))) {
    throw new Error(`Shared item ${index + 1} is not a recognized audio or video file.`);
  }
  const typeMime = mediaMime ? mime : payload.shareType === "video" ? "video/*" : payload.shareType === "audio" ? "audio/*" : undefined;
  return { uri, name, kind: mediaKind(name, typeMime) };
}

/** Validate the complete share before copying; never delete or overwrite a source. */
export async function importSharedMedia(
  payloads: readonly SharePayload[],
  onProgress: (current: number, total: number) => void = () => {},
): Promise<SelectedMedia[]> {
  if (!payloads.length) throw new Error("No shared audio or video was received.");
  // Bound raw work before provider queries, including pathological duplicate lists.
  if (payloads.length > 200) throw new Error("Too many shared items. Please share a smaller batch.");
  const uniquePayloads = new Map<string, SharePayload>();
  for (const payload of payloads) {
    if (!payload?.value || !/^(content|file):\/\//i.test(payload.value)) {
      throw new Error("A shared item is not an accessible local file.");
    }
    const previous = uniquePayloads.get(payload.value);
    if (previous && (previous.shareType !== payload.shareType ||
        (previous.mimeType || "").toLowerCase() !== (payload.mimeType || "").toLowerCase())) {
      throw new Error("A shared file has conflicting type information. Please share it again.");
    }
    if (!previous) uniquePayloads.set(payload.value, payload);
  }
  if (uniquePayloads.size > MAX_BATCH_FILES) {
    throw new Error(`A batch can contain up to ${MAX_BATCH_FILES} unique files. Please share a smaller batch.`);
  }
  const unique = await Promise.all([...uniquePayloads.values()].map(describePayload));
  const selection: SelectedMedia[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < unique.length; i++) {
    const item = unique[i];
    onProgress(i + 1, unique.length);
    try {
      const imported = await importToDocuments(item.uri, item.name, undefined, item.kind);
      if (!seen.has(imported.uri)) {
        seen.add(imported.uri);
        selection.push({ uri: imported.uri, name: item.name, kind: readImportedMediaKind(imported) ?? item.kind });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const preserved = selection.length ? ` ${selection.length} earlier copied file(s) remain in Your files.` : "";
      throw new Error(`Could not import shared item ${i + 1} (${item.name}): ${reason}.${preserved}`);
    }
  }
  return selection;
}
