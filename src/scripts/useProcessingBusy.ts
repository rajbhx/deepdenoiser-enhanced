import { useSyncExternalStore } from "react";
import { isProcessingMedia, subscribeProcessingActivity } from "./denoiserSingleton";

/** Recording and file processing share this guard; incoming shares wait for it. */
export function useProcessingBusy(): boolean {
  return useSyncExternalStore(subscribeProcessingActivity, isProcessingMedia, () => false);
}
