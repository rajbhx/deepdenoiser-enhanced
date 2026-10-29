// Both the home screen and share-handler can receive the same Android intent.
// Claim synchronously before either starts an async copy, and briefly suppress
// duplicate notifications after it is consumed.
const inFlight = new Set<string>();
const completed = new Map<string, number>();
export function claimSharedFile(uri: string): boolean {
  const now = Date.now();
  for (const [key, time] of completed) if (now - time > 5000) completed.delete(key);
  if (inFlight.has(uri) || completed.has(uri)) return false;
  inFlight.add(uri);
  return true;
}
export function finishSharedFile(uri: string, success: boolean): void {
  inFlight.delete(uri);
  if (success) completed.set(uri, Date.now());
}
