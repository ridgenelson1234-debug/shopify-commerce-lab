/**
 * Pluggable state for webhook dedupe and dead letters. The in-memory versions
 * here are for tests and single-process use. A production store (Redis, a SQL
 * table with a unique key) implements the same interfaces and adds expiry for
 * finished keys.
 */

export type ClaimResult = "claimed" | "in_flight" | "done";

export interface EventStore {
  /** Atomically take the key. A lease stops a crashed worker from blocking the key forever. */
  claim(key: string, leaseMs: number): Promise<ClaimResult>;
  /** Mark the key finished. Later claims return "done". */
  complete(key: string): Promise<void>;
  /** Give the key back so a later delivery can run again. */
  release(key: string): Promise<void>;
}

type Entry = { state: "in_flight"; leaseUntil: number } | { state: "done" };

export class MemoryEventStore implements EventStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async claim(key: string, leaseMs: number): Promise<ClaimResult> {
    const existing = this.entries.get(key);
    if (existing?.state === "done") return "done";
    if (existing?.state === "in_flight" && existing.leaseUntil > this.now()) return "in_flight";
    this.entries.set(key, { state: "in_flight", leaseUntil: this.now() + leaseMs });
    return "claimed";
  }

  async complete(key: string): Promise<void> {
    this.entries.set(key, { state: "done" });
  }

  async release(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export interface DeadLetter {
  key: string;
  topic: string;
  shopDomain: string | null;
  /** Raw request body as received, kept so the event can be replayed. */
  body: string;
  attempts: number;
  errors: string[];
  deadLetteredAt: string;
}

export interface DeadLetterSink {
  put(entry: DeadLetter): Promise<void>;
}

export class MemoryDeadLetterSink implements DeadLetterSink {
  private readonly items: DeadLetter[] = [];

  async put(entry: DeadLetter): Promise<void> {
    this.items.push(entry);
  }

  list(): readonly DeadLetter[] {
    return this.items;
  }
}
