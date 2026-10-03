import { withIdempotency } from "./idempotency.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";
import type { DeadLetterSink, EventStore } from "./store.js";
import { verifyShopifyHmac } from "./verify.js";

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /** The untouched request bytes. Do not re-serialize parsed JSON. */
  rawBody: Buffer;
}

export interface WebhookEvent {
  /** Dedupe key: shop domain plus event id. */
  key: string;
  eventId: string;
  topic: string;
  shopDomain: string | null;
  rawBody: Buffer;
  payload: unknown;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ReceiverConfig {
  secret: string;
  store: EventStore;
  deadLetters: DeadLetterSink;
  handler: (event: WebhookEvent) => Promise<void>;
  retry: RetryOptions;
  /** Claim lease. Should exceed the worst-case retry window. Default 5 minutes. */
  leaseMs?: number;
  now?: () => Date;
  /** Called when storing state fails (for example the dead-letter sink is down). */
  onError?: (error: unknown, event: WebhookEvent) => void;
}

function header(headers: WebhookRequest["headers"], name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/**
 * Build a receive() function for one webhook endpoint. It does, in order:
 * verify signature, find the event id, parse, claim the id, run the handler
 * with retries, and dead-letter on exhaustion. Response codes:
 *   401 bad or missing signature (nothing is stored or run)
 *   400 missing event id or body that is not JSON
 *   409 the same event is being processed right now (Shopify will redeliver)
 *   200 processed, or a duplicate that was already finished
 *   202 handler failed every attempt, event is in the dead-letter sink
 *   500 the dead-letter sink itself failed (Shopify will redeliver)
 */
export function createWebhookReceiver(config: ReceiverConfig) {
  if (config.secret.length === 0) throw new Error("webhook secret must not be empty");
  const now = config.now ?? (() => new Date());

  const run = withIdempotency(
    config.store,
    async (event: WebhookEvent) => {
      const outcome = await retryWithBackoff(() => config.handler(event), config.retry);
      if (outcome.ok) return { deadLettered: false, attempts: outcome.attempts };

      await config.deadLetters.put({
        key: event.key,
        topic: event.topic,
        shopDomain: event.shopDomain,
        body: event.rawBody.toString("utf8"),
        attempts: outcome.attempts,
        errors: outcome.errors,
        deadLetteredAt: now().toISOString(),
      });
      return { deadLettered: true, attempts: outcome.attempts };
    },
    { leaseMs: config.leaseMs ?? 5 * 60_000 },
  );

  return async function receive(req: WebhookRequest): Promise<WebhookResponse> {
    if (!verifyShopifyHmac(req.rawBody, header(req.headers, "x-shopify-hmac-sha256"), config.secret)) {
      return { status: 401, body: { error: "invalid signature" } };
    }

    const eventId = header(req.headers, "x-shopify-event-id") ?? header(req.headers, "x-shopify-webhook-id");
    if (!eventId) return { status: 400, body: { error: "missing event id" } };

    let payload: unknown;
    try {
      payload = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "body is not valid JSON" } };
    }

    const shopDomain = header(req.headers, "x-shopify-shop-domain") ?? null;
    const event: WebhookEvent = {
      key: `${shopDomain ?? "unknown-shop"}:${eventId}`,
      eventId,
      topic: header(req.headers, "x-shopify-topic") ?? "unknown",
      shopDomain,
      rawBody: req.rawBody,
      payload,
    };

    try {
      const result = await run(event);
      if (result.status === "duplicate") return { status: 200, body: { ok: true, duplicate: true } };
      if (result.status === "in_flight") return { status: 409, body: { error: "event is being processed" } };
      if (result.value.deadLettered) {
        return { status: 202, body: { ok: false, deadLettered: true, attempts: result.value.attempts } };
      }
      return { status: 200, body: { ok: true, attempts: result.value.attempts } };
    } catch (err) {
      // Reached when the store or the dead-letter sink fails. A 5xx makes Shopify redeliver.
      config.onError?.(err, event);
      return { status: 500, body: { error: "could not record failed event" } };
    }
  };
}
