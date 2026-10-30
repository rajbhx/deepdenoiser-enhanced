/**
 * Privacy-first diagnostic records. Only these closed enums and bounded numbers
 * can enter the history. Never persist raw errors, stacks, filenames, URIs,
 * media hashes or arbitrary context strings.
 */
export const DOMAINS = ["app", "ui", "import", "share", "process", "record", "export", "diagnostics", "model"] as const;
export const RECORD_STOP_STAGES = [
  "record-stop-native", "record-stop-drain", "record-stop-original", "record-stop-reconcile",
  "record-stop-wrap", "record-stop-save", "record-stop-reprocess",
] as const;
export const STAGES = ["general", "prepare", "cache", "decode", "analyze", "model", "denoise", "finalize", "mux", "import", "share", "record-start", "record-stop", ...RECORD_STOP_STAGES, "export", "self-check", "storage"] as const;
export const CODES = ["START", "OK", "FAIL_MEMORY", "FAIL_STORAGE", "FAIL_PERMISSION", "FAIL_DECODE", "FAIL_MODEL", "FAIL_INTEGRITY", "FAIL_IO", "FAIL_RECORDER", "FAIL_UNKNOWN", "CANCELLED", "INTERRUPTED"] as const;
export const LEVELS = ["info", "warning", "error"] as const;
export const MAX_DIAGNOSTIC_EVENTS = 50;

export type DiagnosticDomain = typeof DOMAINS[number];
export type DiagnosticStage = typeof STAGES[number];
export type RecordingStopStage = typeof RECORD_STOP_STAGES[number];
export type DiagnosticCode = typeof CODES[number];
export type DiagnosticLevel = typeof LEVELS[number];
export type DiagnosticEvent = {
  domain: DiagnosticDomain;
  stage: DiagnosticStage;
  code: DiagnosticCode;
  level: DiagnosticLevel;
  time: number;
  elapsedMs?: number;
};

const includes = (values: readonly string[], value: unknown): value is string =>
  typeof value === "string" && values.includes(value);

/** Reconstruct the record; extra keys in persisted or supplied objects are dropped. */
export function safeEvent(value: unknown): DiagnosticEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (!includes(DOMAINS, event.domain) || !includes(STAGES, event.stage) ||
      !includes(CODES, event.code) || !includes(LEVELS, event.level) ||
      !Number.isSafeInteger(event.time) || (event.time as number) < 0) return null;
  const result: DiagnosticEvent = {
    domain: event.domain as DiagnosticDomain, stage: event.stage as DiagnosticStage,
    code: event.code as DiagnosticCode, level: event.level as DiagnosticLevel,
    time: event.time as number,
  };
  if (event.elapsedMs !== undefined) {
    if (!Number.isSafeInteger(event.elapsedMs) || (event.elapsedMs as number) < 0 ||
        (event.elapsedMs as number) > 86400000) return null;
    result.elapsedMs = event.elapsedMs as number;
  }
  return result;
}

export function parseHistory(value: unknown): DiagnosticEvent[] {
  if (!value || typeof value !== "object") return [];
  const record = value as { version?: unknown; enabled?: unknown; events?: unknown };
  if (record.version !== 1 || record.enabled !== true || !Array.isArray(record.events)) return [];
  return record.events.slice(-MAX_DIAGNOSTIC_EVENTS).map(safeEvent).filter((item): item is DiagnosticEvent => item !== null);
}

/** Inspect a message only to choose a fixed category; never return/store it. */
export function classifyDiagnosticError(error: unknown, domain: DiagnosticDomain): DiagnosticCode {
  let message = "";
  try { message = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : String(error).toLowerCase(); }
  catch { return "FAIL_UNKNOWN"; }
  if (/cancelled|canceled/.test(message)) return "CANCELLED";
  if (/out of memory|outofmemory|allocation failed|heap space/.test(message)) return "FAIL_MEMORY";
  if (/no space|enospc|disk full|storage full|insufficient storage/.test(message)) return "FAIL_STORAGE";
  if (/permission|access denied|not allowed|securityexception/.test(message)) return "FAIL_PERMISSION";
  if (/incomplete|short.read|truncat|fingerprint|sha.?256|integrity|checksum|non.finite/.test(message)) return "FAIL_INTEGRITY";
  if (/no audio track|decoder|decoding|mediacodec|unsupported codec|transcode/.test(message)) return "FAIL_DECODE";
  if (/onnx|model|inference|tensor|session not initialized/.test(message)) return "FAIL_MODEL";
  if (/recorder|recording|microphone/.test(message) || domain === "record") return "FAIL_RECORDER";
  if (/file|i\/o|ioexception|read|write|copy|save|export/.test(message)) return "FAIL_IO";
  return "FAIL_UNKNOWN";
}

export const EVENT_LABELS: Record<DiagnosticCode, { label: string; advice: string }> = {
  START: { label: "Started", advice: "" },
  OK: { label: "Completed", advice: "" },
  CANCELLED: { label: "Stopped or cancelled", advice: "" },
  INTERRUPTED: { label: "Interrupted or unknown", advice: "Check the original in Your files before retrying." },
  FAIL_MEMORY: { label: "Memory problem", advice: "Try a shorter test clip and close other apps." },
  FAIL_STORAGE: { label: "Storage problem", advice: "Check available space; keep your originals." },
  FAIL_PERMISSION: { label: "Access problem", advice: "Check the relevant Android permission or choose the file again." },
  FAIL_DECODE: { label: "Media decoding problem", advice: "Try another test file or a different format." },
  FAIL_MODEL: { label: "AI model problem", advice: "Run the model self-check while the app is idle." },
  FAIL_INTEGRITY: { label: "Data integrity problem", advice: "Keep the original; retry with a copy and check the output." },
  FAIL_IO: { label: "File operation problem", advice: "Check available space and access, then retry with a copy." },
  FAIL_RECORDER: { label: "Recorder problem", advice: "Check recorder status and Your files for the original." },
  FAIL_UNKNOWN: { label: "Unexpected problem", advice: "Review the operation and try again with test media." },
};

/** Accept only short, display-safe labels in an exported report. */
export function safeLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  const result = value.replace(/[^a-zA-Z0-9 ._+()-]/g, "").trim().slice(0, 80);
  return result || fallback;
}
