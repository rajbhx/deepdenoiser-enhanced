import { deleteDiagnosticHistory, readDiagnosticHistory, writeDiagnosticHistory } from "@/modules/AudioProcessorModule";
import {
  classifyDiagnosticError, MAX_DIAGNOSTIC_EVENTS, parseHistory, safeEvent,
  type DiagnosticCode, type DiagnosticDomain, type DiagnosticEvent, type DiagnosticLevel, type DiagnosticStage,
} from "./diagnosticsCore";

export type DiagnosticSnapshot = {
  events: readonly DiagnosticEvent[];
  persistent: boolean;
  ready: boolean;
  storageError: string | null;
};
let state: DiagnosticSnapshot = { events: [], persistent: false, ready: false, storageError: null };
const listeners = new Set<() => void>();
let initialization: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let storageQueue: Promise<void> = Promise.resolve();
let installedGlobalHandler = false;

function update(patch: Partial<DiagnosticSnapshot>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) { try { listener(); } catch { /* diagnostics must not break the app */ } }
}
export const getDiagnosticSnapshot = () => state;
export function subscribeDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function serializedHistory(): string {
  return JSON.stringify({ version: 1, enabled: true, events: state.events.map(safeEvent).filter(Boolean) });
}
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(work, work);
  storageQueue = result.then(() => undefined, () => undefined);
  return result;
}
function cancelScheduledWrite(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
function scheduleWrite(): void {
  if (!state.persistent || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void enqueue(async () => {
      if (state.persistent) await writeDiagnosticHistory(serializedHistory());
    }).catch(() => update({ storageError: "Could not save diagnostic history. Recent events may remain only in memory." }));
  }, 750);
}

/** Read the opt-in flag from no-backup storage. Until then events stay in memory. */
export function initializeDiagnostics(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const raw = await readDiagnosticHistory();
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        const object = parsed as { version?: unknown; enabled?: unknown; events?: unknown };
        if (!object || object.version !== 1 || object.enabled !== true || !Array.isArray(object.events)) {
          throw new Error("Invalid history");
        }
        const restored = parseHistory(parsed);
        update({ events: [...restored, ...state.events].slice(-MAX_DIAGNOSTIC_EVENTS), persistent: true, ready: true });
        scheduleWrite();
      } else update({ ready: true });
    } catch {
      update({ ready: true, persistent: false, storageError: "Could not read saved diagnostic history. No new history is being saved." });
    }
  })();
  return initialization;
}

/** Events contain fixed enum labels and bounded numbers only; never arbitrary error text. */
export function recordDiagnostic(
  domain: DiagnosticDomain, stage: DiagnosticStage, code: DiagnosticCode,
  level: DiagnosticLevel = "info", elapsedMs?: number,
): void {
  try {
    const duration = typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
      ? Math.max(0, Math.min(86400000, Math.round(elapsedMs))) : undefined;
    const entry = safeEvent({ domain, stage, code, level, time: Date.now(), ...(duration !== undefined ? { elapsedMs: duration } : {}) });
    if (!entry) return;
    update({ events: [...state.events, entry].slice(-MAX_DIAGNOSTIC_EVENTS) });
    scheduleWrite();
  } catch { /* diagnostics must never affect recording or processing */ }
}

export function recordDiagnosticError(domain: DiagnosticDomain, stage: DiagnosticStage, error: unknown): void {
  try {
    const code = classifyDiagnosticError(error, domain);
    recordDiagnostic(domain, stage, code, code === "CANCELLED" ? "info" : "error");
  } catch { /* no arbitrary exception content is saved */ }
}

/** Explicit user action only. History remains local and is never uploaded. */
export async function setDiagnosticPersistence(enabled: boolean): Promise<void> {
  await initializeDiagnostics();
  cancelScheduledWrite();
  try {
    if (enabled) {
      await enqueue(() => writeDiagnosticHistory(serializedHistory()));
      update({ persistent: true, storageError: null });
      // Events can arrive while the first write is pending.
      scheduleWrite();
    } else {
      await enqueue(() => deleteDiagnosticHistory());
      update({ persistent: false, storageError: null });
    }
  } catch {
    update({ storageError: enabled ? "Could not enable saved history." : "Could not delete saved history; it may still exist on this device." });
    throw new Error(enabled ? "Could not enable saved history." : "Could not delete saved history.");
  }
}

/** Clearing history never touches user media or caches. */
export async function clearDiagnosticHistory(): Promise<void> {
  await initializeDiagnostics();
  cancelScheduledWrite();
  update({ events: [], storageError: null });
  try {
    if (state.persistent) await enqueue(() => writeDiagnosticHistory(serializedHistory()));
    else await enqueue(() => deleteDiagnosticHistory());
  } catch {
    update({ storageError: "Could not clear saved history; older entries may still exist on this device." });
    throw new Error("Could not clear saved history.");
  }
}

/** Observe uncaught JS exceptions, then delegate to React Native's original handler. */
export function installDiagnosticGlobalHandler(): void {
  if (installedGlobalHandler) return;
  type Handler = (error: unknown, isFatal?: boolean) => void;
  const utility = (globalThis as typeof globalThis & { ErrorUtils?: {
    getGlobalHandler?: () => Handler;
    setGlobalHandler?: (handler: Handler) => void;
  } }).ErrorUtils;
  if (!utility?.getGlobalHandler || !utility.setGlobalHandler) return;
  const previous = utility.getGlobalHandler();
  if (typeof previous !== "function") return;
  utility.setGlobalHandler((error, fatal) => {
    recordDiagnosticError("app", "general", error);
    previous(error, fatal);
  });
  installedGlobalHandler = true;
}
