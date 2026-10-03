import type { EventStore } from "./store.js";

export type IdempotentResult<R> =
  | { status: "processed"; value: R }
  | { status: "duplicate" }
  | { status: "in_flight" };

export interface IdempotencyOptions {
  /** How long a claim holds before another worker may take over. */
  leaseMs: number;
}

/**
 * Wrap a handler so one key runs to success at most once.
 * - key already finished: skip, report "duplicate"
 * - key being processed elsewhere: skip, report "in_flight"
 * - handler throws: release the key so a redelivery can try again, rethrow
 */
export function withIdempotency<E extends { key: string }, R>(
  store: EventStore,
  handler: (event: E) => Promise<R>,
  options: IdempotencyOptions,
): (event: E) => Promise<IdempotentResult<R>> {
  return async (event) => {
    const claim = await store.claim(event.key, options.leaseMs);
    if (claim === "done") return { status: "duplicate" };
    if (claim === "in_flight") return { status: "in_flight" };

    try {
      const value = await handler(event);
      await store.complete(event.key);
      return { status: "processed", value };
    } catch (err) {
      await store.release(event.key);
      throw err;
    }
  };
}
