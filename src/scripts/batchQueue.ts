/** Simple cooperative cancellation shared by the queue and processing engine. */
export interface CancellationToken { cancelled: boolean }

export class ProcessingCancelled extends Error {
  constructor() { super("Processing cancelled"); this.name = "ProcessingCancelled"; }
}

export function throwIfCancelled(token: CancellationToken): void {
  if (token.cancelled) throw new ProcessingCancelled();
}

export type QueueEvent<R> =
  | { type: "started"; index: number }
  | { type: "completed"; index: number; result: R }
  | { type: "failed"; index: number; error: Error }
  | { type: "cancelled"; index: number };

/**
 * Process one file at a time. A single failure does not discard the rest of
 * the batch; cancellation stops after the current cooperative/native step and
 * marks every not-yet-started item as cancelled.
 */
export async function runSequentialQueue<T, R>(
  items: readonly T[],
  token: CancellationToken,
  worker: (item: T, index: number, token: CancellationToken) => Promise<R>,
  notify: (event: QueueEvent<R>) => void,
): Promise<void> {
  for (let index = 0; index < items.length; index++) {
    if (token.cancelled) {
      notify({ type: "cancelled", index });
      continue;
    }
    notify({ type: "started", index });
    try {
      const result = await worker(items[index], index, token);
      // Once a durable output exists, count it as completed even if the user
      // pressed Stop during its final move. The next item will not start.
      notify({ type: "completed", index, result });
    } catch (error) {
      if (token.cancelled || error instanceof ProcessingCancelled) {
        token.cancelled = true;
        notify({ type: "cancelled", index });
      } else {
        notify({ type: "failed", index, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  }
}
