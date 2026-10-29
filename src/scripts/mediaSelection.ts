export interface SelectedMedia {
  uri: string;
  name: string;
  kind: "audio" | "video";
}
export const MAX_BATCH_FILES = 20;

export function mediaKind(name: string, mimeType?: string | null): "audio" | "video" {
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  return /\.(mp4|mov|mkv|avi|m4v|webm)$/i.test(name) ? "video" : "audio";
}

/** Validate route data rather than trusting an arbitrary deep link. */
export function decodeMediaSelection(raw: string): SelectedMedia[] {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(raw));
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_BATCH_FILES).filter((item): item is SelectedMedia =>
      !!item && typeof item === "object" && typeof item.uri === "string" && item.uri.startsWith("file:") &&
      typeof item.name === "string" && (item.kind === "audio" || item.kind === "video"));
  } catch { return []; }
}
