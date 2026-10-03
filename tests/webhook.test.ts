import { describe, expect, it } from "vitest";
import {
  MemoryDeadLetterSink,
  MemoryEventStore,
  PermanentError,
  backoffDelay,
  computeShopifyHmac,
  createWebhookReceiver,
  retryWithBackoff,
  verifyShopifyHmac,
  withIdempotency,
  type WebhookEvent,
} from "../webhook/index.js";

const SECRET = "test-secret-not-real";
const body = (obj: unknown) => Buffer.from(JSON.stringify(obj));

function signedRequest(raw: Buffer, headers: Record<string, string> = {}, secret = SECRET) {
  return {
    rawBody: raw,
    headers: {
      "X-Shopify-Hmac-Sha256": computeShopifyHmac(raw, secret),
      "X-Shopify-Event-Id": "evt-1",
      "X-Shopify-Topic": "orders/create",
      "X-Shopify-Shop-Domain": "example-store.myshopify.com",
      ...headers,
    },
  };
}

function harness(handler: (e: WebhookEvent) => Promise<void>, maxAttempts = 3) {
  const store = new MemoryEventStore();
  const deadLetters = new MemoryDeadLetterSink();
  const sleeps: number[] = [];
  const errors: unknown[] = [];
  const receive = createWebhookReceiver({
    secret: SECRET,
    store,
    deadLetters,
    handler,
    retry: {
      maxAttempts,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    onError: (e) => errors.push(e),
  });
  return { receive, store, deadLetters, sleeps, errors };
}

describe("signature verification", () => {
  const raw = body({ id: 1 });

  it("accepts a correct signature", () => {
    expect(verifyShopifyHmac(raw, computeShopifyHmac(raw, SECRET), SECRET)).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyShopifyHmac(raw, computeShopifyHmac(raw, "other"), SECRET)).toBe(false);
  });

  it("rejects missing, empty and wrong-length headers", () => {
    expect(verifyShopifyHmac(raw, undefined, SECRET)).toBe(false);
    expect(verifyShopifyHmac(raw, "", SECRET)).toBe(false);
    expect(verifyShopifyHmac(raw, "abc", SECRET)).toBe(false);
  });

  it("rejects when the secret is empty", () => {
    expect(verifyShopifyHmac(raw, computeShopifyHmac(raw, ""), "")).toBe(false);
  });

  it("signs the raw bytes: same JSON with different whitespace fails", () => {
    const signed = Buffer.from('{"id":1}');
    const reformatted = Buffer.from('{ "id": 1 }');
    expect(verifyShopifyHmac(reformatted, computeShopifyHmac(signed, SECRET), SECRET)).toBe(false);
  });
});

describe("receiver", () => {
  it("rejects a bad signature with 401 and never runs the handler or stores the event", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
    });
    const req = signedRequest(body({ id: 1 }), { "X-Shopify-Hmac-Sha256": "AAAA" });
    const res = await h.receive(req);
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
    expect(await h.store.claim("example-store.myshopify.com:evt-1", 1000)).toBe("claimed");
  });

  it("rejects a body that was altered after signing", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
    });
    const req = signedRequest(body({ id: 1 }));
    const res = await h.receive({ ...req, rawBody: body({ id: 2 }) });
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("returns 400 when there is no event id or webhook id", async () => {
    const h = harness(async () => {});
    const raw = body({ id: 1 });
    const res = await h.receive({
      rawBody: raw,
      headers: { "x-shopify-hmac-sha256": computeShopifyHmac(raw, SECRET) },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a signed body that is not JSON, without running the handler", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
    });
    const res = await h.receive(signedRequest(Buffer.from("not json")));
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("falls back to the webhook id header when there is no event id", async () => {
    const seen: string[] = [];
    const h = harness(async (e) => {
      seen.push(e.eventId);
    });
    const raw = body({ id: 1 });
    const res = await h.receive({
      rawBody: raw,
      headers: {
        "x-shopify-hmac-sha256": computeShopifyHmac(raw, SECRET),
        "x-shopify-webhook-id": "wh-9",
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["wh-9"]);
  });

  it("dedupes a replayed delivery: handler runs once, second answer is 200 duplicate", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
    });
    const req = signedRequest(body({ id: 1 }));
    const first = await h.receive(req);
    const second = await h.receive(req);
    expect(first).toEqual({ status: 200, body: { ok: true, attempts: 1 } });
    expect(second).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(calls).toBe(1);
  });

  it("treats the same event id from different shops as different events", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
    });
    const raw = body({ id: 1 });
    await h.receive(signedRequest(raw, { "X-Shopify-Shop-Domain": "shop-a.example" }));
    await h.receive(signedRequest(raw, { "X-Shopify-Shop-Domain": "shop-b.example" }));
    expect(calls).toBe(2);
  });

  it("answers 409 while the same event is still being processed, and runs the handler once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const h = harness(async () => {
      calls++;
      await gate;
    });
    const req = signedRequest(body({ id: 1 }));
    const first = h.receive(req);
    await new Promise((r) => setTimeout(r, 10));
    const concurrent = await h.receive(req);
    expect(concurrent.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(calls).toBe(1);
  });

  it("retries a failing handler with exponential backoff, then succeeds", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      if (calls < 3) throw new Error("upstream 503");
    });
    const res = await h.receive(signedRequest(body({ id: 1 })));
    expect(res).toEqual({ status: 200, body: { ok: true, attempts: 3 } });
    // random() is fixed at 0.5, so waits are half of the 100ms then 200ms ceilings.
    expect(h.sleeps).toEqual([50, 100]);
    expect(h.deadLetters.list()).toHaveLength(0);
  });

  it("dead-letters after the last attempt and records every error", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      throw new Error(`failure ${calls}`);
    }, 3);
    const raw = body({ id: 1 });
    const res = await h.receive(signedRequest(raw));
    expect(res).toEqual({ status: 202, body: { ok: false, deadLettered: true, attempts: 3 } });
    expect(calls).toBe(3);
    const [entry] = h.deadLetters.list();
    expect(entry).toMatchObject({
      key: "example-store.myshopify.com:evt-1",
      topic: "orders/create",
      attempts: 3,
      errors: ["failure 1", "failure 2", "failure 3"],
      deadLetteredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(entry?.body).toBe(raw.toString("utf8"));
  });

  it("does not dead-letter the same event twice when Shopify redelivers it", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      throw new Error("always");
    }, 2);
    const req = signedRequest(body({ id: 1 }));
    await h.receive(req);
    const again = await h.receive(req);
    expect(again.body).toEqual({ ok: true, duplicate: true });
    expect(calls).toBe(2);
    expect(h.deadLetters.list()).toHaveLength(1);
  });

  it("dead-letters a PermanentError after one attempt, with no waiting", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      throw new PermanentError("unknown topic");
    });
    const res = await h.receive(signedRequest(body({ id: 1 })));
    expect(res.status).toBe(202);
    expect(calls).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("answers 500 and releases the event when the dead-letter sink is down, so a redelivery can run", async () => {
    const store = new MemoryEventStore();
    const errors: unknown[] = [];
    let healthy = false;
    const receive = createWebhookReceiver({
      secret: SECRET,
      store,
      deadLetters: {
        put: async () => {
          if (!healthy) throw new Error("sink down");
        },
      },
      handler: async () => {
        throw new Error("handler broken");
      },
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
      onError: (e) => errors.push(e),
    });
    const req = signedRequest(body({ id: 1 }));
    expect((await receive(req)).status).toBe(500);
    expect(errors).toHaveLength(1);
    healthy = true;
    expect((await receive(req)).status).toBe(202);
  });

  it("refuses to be built with an empty secret", () => {
    expect(() =>
      createWebhookReceiver({
        secret: "",
        store: new MemoryEventStore(),
        deadLetters: new MemoryDeadLetterSink(),
        handler: async () => {},
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      }),
    ).toThrow(/secret/);
  });
});

describe("backoff", () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 500 };

  it("doubles the ceiling per attempt and caps it", () => {
    const half = () => 0.5;
    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(n, opts, half))).toEqual([50, 100, 200, 250, 250]);
  });

  it("jitter spans zero to the ceiling", () => {
    expect(backoffDelay(3, opts, () => 0)).toBe(0);
    expect(backoffDelay(3, opts, () => 0.999999)).toBe(399);
  });

  it("retryWithBackoff stops at maxAttempts and reports attempts", async () => {
    const out = await retryWithBackoff(
      async () => {
        throw new Error("x");
      },
      { maxAttempts: 4, ...opts, random: () => 1, sleep: async () => {} },
    );
    expect(out).toMatchObject({ ok: false, attempts: 4, permanent: false });
  });
});

describe("idempotency wrapper and store", () => {
  it("releases the key when the handler throws, so the next delivery runs again", async () => {
    const store = new MemoryEventStore();
    let calls = 0;
    const run = withIdempotency(
      store,
      async (_e: { key: string }) => {
        calls++;
        if (calls === 1) throw new Error("first try fails");
        return "ok";
      },
      { leaseMs: 1000 },
    );
    await expect(run({ key: "k" })).rejects.toThrow("first try fails");
    expect(await run({ key: "k" })).toEqual({ status: "processed", value: "ok" });
    expect(await run({ key: "k" })).toEqual({ status: "duplicate" });
  });

  it("lets another worker take over once a lease has expired", async () => {
    let t = 0;
    const store = new MemoryEventStore(() => t);
    expect(await store.claim("k", 1000)).toBe("claimed");
    t = 999;
    expect(await store.claim("k", 1000)).toBe("in_flight");
    t = 1001;
    expect(await store.claim("k", 1000)).toBe("claimed");
  });
});
