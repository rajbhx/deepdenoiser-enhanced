import * as fs from "expo-file-system";
import { importsDir, outputDir } from "./denoiseCache";
import { recordingsDir } from "./recordingSafety";

export type PrivateMediaGroup = "results" | "recordings" | "imports";
export type PrivateMedia = {
  file: fs.File;
  group: PrivateMediaGroup;
  name: string;
  size: number;
  modified: number;
  video: boolean;
  partial: boolean;
};

/** Discover durable files directly; no separate catalog can be lost on a crash. */
export function listPrivateMedia(): PrivateMedia[] {
  const folders: { dir: fs.Directory; group: PrivateMediaGroup; legacy?: boolean; partial?: boolean }[] = [
    { dir: outputDir(), group: "results" },
    { dir: recordingsDir(), group: "recordings" },
    { dir: importsDir(), group: "imports" },
    // Versions before 2.0.1 stored native recordings at the document root.
    { dir: fs.Paths.document, group: "recordings", legacy: true },
    // Emergency streamed prefixes from older versions or a failed stop.
    { dir: new fs.Directory(fs.Paths.cache), group: "recordings", partial: true },
  ];
  const items: PrivateMedia[] = [];
  for (const { dir, group, legacy, partial } of folders) {
    if (!dir.exists) continue;
    for (const item of dir.list()) {
      if (!(item instanceof fs.File) || !item.exists) continue;
      const raw = item.name;
      if (partial && !/^orig_\d+\.pcm$/i.test(raw)) continue;
      if (legacy && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.wav$/i.test(raw)) continue;
      if (!legacy && !partial && group === "recordings" && !/\.wav$/i.test(raw)) continue;
      if (group === "results" && !/\.(wav|mp4)$/i.test(raw)) continue;
      if (group === "imports" && (raw.startsWith("_pending_") || raw.endsWith(".tmp"))) continue;
      const name = partial ? `Partial backup · ${raw}` : group === "imports" ? raw.replace(/^[0-9a-f]{64}_/i, "") : raw;
      items.push({ file: item, group, name, size: item.size,
        modified: item.modificationTime ?? 0, partial: !!partial, video: /\.(mp4|mov|m4v|webm|mkv)$/i.test(name) });
    }
  }
  return items.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
}
