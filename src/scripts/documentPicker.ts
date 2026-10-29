import * as DocumentPicker from "expo-document-picker";
import type {
  DocumentPickerOptions,
  DocumentPickerResult,
} from "expo-document-picker";
import { requireNativeModule } from "expo-modules-core";
import {
  AppState,
  type AppStateStatus,
  type NativeEventSubscription,
} from "react-native";

/**
 * Serialised, self-healing wrapper around expo-document-picker.
 *
 * Android's ExpoDocumentPicker (SDK 57) keeps ONE `pendingPromise` and clears
 * it only from `OnActivityResult`. Two things leave it set for the rest of the
 * process:
 *
 *   1. A second getDocumentAsync() while the picker is open (double tap) is
 *      rejected with "Different document picking in progress...".
 *   2. A lost activity result — Back gesture, OEM file picker, or the host
 *      activity being killed while the picker is up — never settles, so EVERY
 *      later pick throws that same error.
 *
 * patches/expo-document-picker+57.0.3.patch adds `cancelPendingPick()` to the
 * native module so case 2 is recoverable. This module serialises calls, watches
 * the app lifecycle, and uses that escape hatch when a result goes missing.
 */

const CANCELED: DocumentPickerResult = { canceled: true, assets: null };

type RecoverablePickerModule = {
  cancelPendingPick?: () => Promise<void>;
};

/** Time a real activity result has to arrive after the app comes back. */
const RESUME_GRACE_MS = 8_000;
/** Absolute ceiling in case AppState never reports the background transition. */
const HARD_TIMEOUT_MS = 3 * 60 * 1000;

type ActivePick = {
  promise: Promise<DocumentPickerResult>;
  /** Settles our raced promise as a cancellation (used by the watchdog). */
  cancel: () => void;
  wentBackground: boolean;
  resumed: boolean;
  done: boolean;
  subscription: NativeEventSubscription | null;
  resumeTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
};

let active: ActivePick | null = null;

function isPickingInProgress(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /different document picking in progress/i.test(message);
}

/**
 * Ask the patched native module to settle a pick whose activity result was
 * lost. On unpatched builds / web this is a no-op — the JS lock is still
 * released afterwards, and the next pick retries via the PickingInProgress
 * branch below.
 */
async function resetNativePicker(): Promise<void> {
  try {
    const native = requireNativeModule<RecoverablePickerModule>(
      "ExpoDocumentPicker",
    );
    if (typeof native.cancelPendingPick !== "function") return;
    await Promise.race([
      native.cancelPendingPick(),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
  } catch (error) {
    console.warn("[documentPicker] native reset unavailable:", error);
  }
}

function finish(pick: ActivePick): void {
  if (pick.done) return;
  pick.done = true;
  if (active === pick) active = null;
  if (pick.resumeTimer) clearTimeout(pick.resumeTimer);
  if (pick.hardTimer) clearTimeout(pick.hardTimer);
  pick.resumeTimer = null;
  pick.hardTimer = null;
  pick.subscription?.remove();
  pick.subscription = null;
}

function recover(pick: ActivePick): void {
  if (pick.done) return;
  void resetNativePicker().finally(() => {
    // Resolving the stale native promise normally settles `pick.promise`.
    // Cancel anyway so an unpatched build can still unlock the UI.
    pick.cancel();
    finish(pick);
  });
}

function onAppState(pick: ActivePick, state: AppStateStatus): void {
  if (pick.done) return;

  if (state === "background" || state === "inactive") {
    pick.wentBackground = true;
    if (pick.resumeTimer) clearTimeout(pick.resumeTimer);
    pick.resumeTimer = null;
    return;
  }

  if (state !== "active" || !pick.wentBackground || pick.resumeTimer) return;

  pick.resumed = true;
  pick.resumeTimer = setTimeout(() => {
    pick.resumeTimer = null;
    // The picker UI is gone and no result arrived: the activity result was
    // dropped. 8s is enough for the cache copy of a normal file to complete.
    if (!pick.done) recover(pick);
  }, RESUME_GRACE_MS);
}

async function nativePick(
  options: DocumentPickerOptions,
): Promise<DocumentPickerResult> {
  try {
    return await DocumentPicker.getDocumentAsync(options);
  } catch (error) {
    if (!isPickingInProgress(error)) throw error;

    // The module was already wedged (e.g. an install built before the patch,
    // or a stale promise from another call site). Clear it and retry once.
    await resetNativePicker();
    try {
      return await DocumentPicker.getDocumentAsync(options);
    } catch (retryError) {
      if (isPickingInProgress(retryError)) {
        throw new Error(
          "The file picker is stuck. Please restart the app to reset it.",
        );
      }
      throw retryError;
    }
  }
}

/**
 * Open the document picker. Concurrent callers are ignored (returned a
 * `canceled` result) instead of launching a second native picker; a call made
 * after a lost result recovers the module and starts a fresh pick.
 */
export function pickDocument(
  options: DocumentPickerOptions,
): Promise<DocumentPickerResult> {
  // A resumed-but-unsettled pick means the picker UI went away without a
  // result. Recover first so this call can actually open a new picker.
  let stale: ActivePick | null = null;
  if (active) {
    if (!active.resumed) return Promise.resolve(CANCELED);
    stale = active;
    recover(stale);
  }

  const start = (): Promise<DocumentPickerResult> => {
    let cancel!: () => void;
    const cancelled = new Promise<DocumentPickerResult>((resolve) => {
      cancel = () => resolve(CANCELED);
    });

    const promise = Promise.race([nativePick(options), cancelled]);

    const pick: ActivePick = {
      promise,
      cancel,
      wentBackground: false,
      resumed: false,
      done: false,
      subscription: null,
      resumeTimer: null,
      hardTimer: null,
    };
    active = pick;

    pick.subscription = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => onAppState(pick, state),
    );
    pick.hardTimer = setTimeout(() => {
      pick.hardTimer = null;
      if (!pick.done) recover(pick);
    }, HARD_TIMEOUT_MS);

    promise.then(
      () => finish(pick),
      () => finish(pick),
    );

    return promise;
  };

  if (!stale) return start();

  return stale.promise
    .catch(() => CANCELED)
    .then(() => {
      // Ensure the old slot is fully released before starting a new one.
      finish(stale!);
      return start();
    });
}

/** True while a pick is open or awaiting its (possibly lost) result. */
export function isDocumentPickerBusy(): boolean {
  return active !== null;
}
