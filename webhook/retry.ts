/** Throw this from a handler when retrying cannot help (bad payload, unknown topic). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export interface RetryOptions {
  /** Total tries including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected so tests are deterministic. Defaults to Math.random. */
  random?: () => number;
  /** Injected so tests do not wait. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export type RetryOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; attempts: number; errors: string[]; permanent: boolean };

/**
 * Exponential backoff with full jitter: the ceiling doubles per attempt up to
 * maxDelayMs, and the actual wait is a random point between 0 and the ceiling.
 * `attempt` is the number of the attempt that just failed, starting at 1.
 */
export function backoffDelay(
  attempt: number,
  options: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs">,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryOutcome<T>> {
  if (options.maxAttempts < 1) throw new RangeError("maxAttempts must be at least 1");
  const sleep = options.sleep ?? realSleep;
  const errors: string[] = [];

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return { ok: true, value: await fn(attempt), attempts: attempt };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      if (err instanceof PermanentError) {
        return { ok: false, attempts: attempt, errors, permanent: true };
      }
      if (attempt === options.maxAttempts) {
        return { ok: false, attempts: attempt, errors, permanent: false };
      }
      await sleep(backoffDelay(attempt, options, options.random));
    }
  }
  // Unreachable: the loop always returns. Kept so the compiler sees a total function.
  return { ok: false, attempts: options.maxAttempts, errors, permanent: false };
}
