export type MediaKind = "audio" | "video";

export interface SelectedMedia {
  uri: string;
  name: string;
  kind: MediaKind;
}
export const MAX_BATCH_FILES = 20;

export function mediaKind(name: string, mimeType?: string | null): MediaKind {
  const mime = mimeType?.toLowerCase();
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  return /\.(mp4|mov|mkv|avi|m4v|webm|3gp|mpeg|mpg|ts)$/i.test(name) ? "video" : "audio";
}

/** Validate route data rather than trusting an arbitrary deep link. */
export function decodeMediaSelection(raw: string): SelectedMedia[] {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(raw));
    if (!Array.isArray(value) || !value.length || value.length > MAX_BATCH_FILES) return [];
    const valid = value.every((item: unknown): item is SelectedMedia =>
      !!item && typeof item === "object" && typeof (item as SelectedMedia).uri === "string" && (item as SelectedMedia).uri.startsWith("file:") &&
      typeof (item as SelectedMedia).name === "string" && ((item as SelectedMedia).kind === "audio" || (item as SelectedMedia).kind === "video"));
    return valid ? value as SelectedMedia[] : [];
  } catch { return []; }
}
