import { requireNativeModule } from "expo";
import * as Linking from "expo-linking";
import { getSharedPayloads, type SharePayload } from "expo-sharing";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { onShareClaimReleased } from "./shareClaim";

// The patched Android sharing module queues raw URI intents and assigns each
// one a native generation. Never use its resolver: that copies provider names
// directly into common cache and can collide with recording recovery data.
const sharing = requireNativeModule<{
  getShareIntentGeneration(): string;
  acknowledgeShareIntent(generation: string): boolean;
  takeShareQueueOverflow(): number;
}>("ExpoSharing");
const listeners = new Set<() => void>();
let pendingOverflow = 0;
const keyFor = (payloads: readonly SharePayload[]) => JSON.stringify(
  payloads.map(item => JSON.stringify([item.value, item.shareType, item.mimeType ?? ""])).sort(),
);
type Snapshot = { generation: string; payloads: SharePayload[] };

/** A stale completion cannot consume a newer, identical native intent. */
export function isCurrentShare(payloads: readonly SharePayload[], generation: string): boolean {
  try {
    return !!generation && generation === sharing.getShareIntentGeneration() &&
      keyFor(payloads) === keyFor(getSharedPayloads());
  } catch { return false; }
}

function refreshListeners(): void { for (const listener of listeners) listener(); }

export function useRawIncomingShare() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ generation: "", payloads: [] });
  const [error, setError] = useState<Error | null>(null);
  const failedGeneration = useRef("");
  const refresh = useCallback(() => {
    try {
      const generation = sharing.getShareIntentGeneration();
      if (!generation) {
        pendingOverflow += sharing.takeShareQueueOverflow();
        failedGeneration.current = "";
        setSnapshot(current => current.generation || current.payloads.length ? { generation: "", payloads: [] } : current);
        const message = pendingOverflow > 0
          ? `${pendingOverflow} incoming share request(s) could not be queued. Please share those files again.` : "";
        setError(current => message ? (current?.message === message ? current : new Error(message)) : null);
        return;
      }
      failedGeneration.current = generation;
      const payloads = getSharedPayloads();
      if (generation !== sharing.getShareIntentGeneration()) return; // Head changed; the next refresh will read it.
      if (!payloads.length) throw new Error("The share contained no readable media.");
      failedGeneration.current = "";
      setSnapshot(current => current.generation === generation && keyFor(current.payloads) === keyFor(payloads)
        ? current : { generation, payloads });
      setError(null);
    } catch (reason) {
      const next = reason instanceof Error ? reason : new Error(String(reason));
      setSnapshot(current => current.generation || current.payloads.length ? { generation: "", payloads: [] } : current);
      setError(current => current?.message === next.message ? current : next);
    }
  }, []);
  useEffect(() => {
    listeners.add(refresh);
    const unsubscribe = onShareClaimReleased(refresh);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize the native intent once on subscription
    refresh();
    const appState = AppState.addEventListener("change", state => { if (state === "active") refresh(); });
    const url = Linking.addEventListener("url", refresh);
    return () => { unsubscribe(); listeners.delete(refresh); appState.remove(); url.remove(); };
  }, [refresh]);
  const consume = useCallback((expected: readonly SharePayload[], generation: string) => {
    try {
      if (isCurrentShare(expected, generation)) sharing.acknowledgeShareIntent(generation);
    } catch { return; } // Never clear a newer or uninspectable intent.
    refreshListeners();
  }, []);
  const discardUnreadable = useCallback(() => {
    try {
      if (!sharing.getShareIntentGeneration() && pendingOverflow) {
        pendingOverflow = 0;
      } else {
        const generation = failedGeneration.current;
        if (generation && generation === sharing.getShareIntentGeneration()) {
          try {
            // If it became readable, refresh it rather than discard a valid share.
            if (!getSharedPayloads().length) sharing.acknowledgeShareIntent(generation);
          } catch { sharing.acknowledgeShareIntent(generation); }
        }
      }
    } catch { /* Preserve an uninspectable intent until the user can retry. */ }
    refreshListeners();
  }, []);
  return { ...snapshot, error, consume, discardUnreadable };
}
