// Both Home and the share-handler can receive an intent. A single in-flight
// claim serializes batches; release wakes listeners in case a newer intent
// arrived while the old batch was being copied.
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

export function claimSharedBatch(values: readonly string[]): string | null {
  const key = JSON.stringify([...values].sort());
  if (inFlight.size) return null;
  inFlight.add(key);
  return key;
}

export function finishSharedBatch(key: string): void {
  inFlight.delete(key);
  for (const listener of listeners) listener();
}

export function onShareClaimReleased(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
