import type { DiagnosticsInfo } from "@/modules/AudioProcessorModule";
import { EVENT_LABELS, safeEvent, safeLabel, type DiagnosticEvent } from "./diagnosticsCore";
import type { DiagnosticRunResult } from "./diagnosticSelfCheck";
import type { AppSettings } from "./settings";

export type RecorderState = "idle" | "active" | "paused" | "unknown";
export type ShareState = "pending" | "none" | "unknown";
export type ReportInput = {
  info: DiagnosticsInfo | null;
  buildCommit: string;
  settings: AppSettings | null;
  engine: string;
  recorder: RecorderState;
  busy: boolean;
  share: ShareState;
  events: readonly DiagnosticEvent[];
  selfCheck: DiagnosticRunResult | null;
  benchmarks: Partial<Record<"cpu" | "xnnpack" | "nnapi", DiagnosticRunResult>>;
  includeDevice: boolean;
};
const mib = (bytes: number) => Number.isFinite(bytes) && bytes >= 0 ? `${Math.round(bytes / 1048576)} MiB` : "unknown";
const digest = (value: string | null | undefined) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : "unavailable";

/** Build from allowlisted fields only; raw exceptions and media never enter this report. */
export function buildDiagnosticReport(input: ReportInput): string {
  const info = input.info;
  const commit = /^[0-9a-f]{7,40}$/i.test(input.buildCommit) ? input.buildCommit.toLowerCase() : "unknown";
  const lines = [
    "DeepDenoiser diagnostic report",
    "Review before sharing. System logs and raw error details are not included.",
    `App: ${safeLabel(info?.versionName)} (version code ${Number.isSafeInteger(info?.versionCode) ? info?.versionCode : "unknown"})`,
    `Build commit: ${commit}`,
    `Build mode: ${info ? (info.debuggable ? "debuggable" : "not debuggable") : "unknown"}`,
    `Certificate subject hint: ${info?.androidDebugSubject === true ? "Android Debug — testing only" : info?.androidDebugSubject === false ? "other — not release approval" : "unknown"}`,
    `Certificate SHA-256: ${digest(info?.certificateSha256)}`,
    `Runtime setting: ${safeLabel(input.settings?.runtime)}; attempted provider: ${safeLabel(input.engine)} (actual hardware not verified)`,
    `Recorder: ${input.recorder}; processing/diagnostics guard: ${input.busy ? "busy" : "idle"}; incoming share: ${input.share}`,
    "",
    "Self-check (synthetic data only):",
  ];
  if (!input.selfCheck) lines.push("Not run");
  else {
    for (const check of input.selfCheck.checks) lines.push(`- ${safeLabel(check.label)}: ${check.status}${check.elapsedMs === undefined ? "" : ` (${Math.max(0, Math.round(check.elapsedMs))} ms)`}`);
    lines.push(`- Attempted provider: ${safeLabel(input.selfCheck.attemptedEngine)}`);
  }
  for (const mode of ["cpu", "xnnpack", "nnapi"] as const) {
    const result = input.benchmarks[mode];
    if (!result) continue;
    const factor = result.realtimeFactor;
    lines.push(`- ${mode.toUpperCase()} short test: ${result.checks[0]?.status ?? "unknown"}; attempted ${safeLabel(result.attemptedEngine)}; speed ${typeof factor === "number" && Number.isFinite(factor) && factor >= 0 ? `${Math.min(factor, 10000).toFixed(2)}x` : "unknown"} (indicative only)`);
  }
  lines.push("", "Recent structured events (no raw messages or media details):");
  const events = input.events.map(safeEvent).filter((item): item is DiagnosticEvent => item !== null);
  if (!events.length) lines.push("None");
  for (const event of events) lines.push(`- ${event.domain}/${event.stage}: ${EVENT_LABELS[event.code].label} [${event.code}]${event.elapsedMs === undefined ? "" : `, ${event.elapsedMs} ms`}`);
  if (input.includeDevice && info) {
    lines.push("", "Device details (included by your choice):",
      `Device: ${safeLabel(info.manufacturer)} ${safeLabel(info.model)}; Android ${safeLabel(info.androidVersion)} (API ${Number.isSafeInteger(info.sdk) ? info.sdk : "unknown"})`,
      `ABI: ${safeLabel(info.abi)}; logical processors: ${Number.isSafeInteger(info.cpuCount) ? info.cpuCount : "unknown"}`,
      `Available/total RAM: ${mib(info.availableMemoryBytes)} / ${mib(info.totalMemoryBytes)}; app PSS: ${mib(info.processPssBytes)} (approximate)`,
      `Free app-storage volume: ${mib(info.freeStorageBytes)}; battery: ${info.batteryPercent === null ? "unknown" : `${info.batteryPercent}%`}`,
      `Microphone permission: ${info.microphoneGranted ? "granted" : "not granted"}; notifications: ${info.notificationsEnabled ? "enabled" : "disabled"}`,
      `Media-read grants: audio ${info.mediaAudioGranted ? "granted" : "not granted"}, video ${info.mediaVideoGranted ? "granted" : "not granted"}; picker access may still work`,
      `Last recorded process exit: ${info.previousExit ? safeLabel(info.previousExit.reason) : "unavailable"} (may be unrelated to a crash)`);
  }
  lines.push("", "No recordings, media names, paths, URIs, media hashes, raw exceptions, or automatic upload are included by design. Please review this report; Android/system logs shared separately may contain private information.");
  return lines.join("\n");
}
