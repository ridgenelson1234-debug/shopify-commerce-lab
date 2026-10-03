import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdminHttpError,
  CheckpointMismatchError,
  SpecError,
  ThrottleError,
  runBulk,
  valuesEqual,
  type BulkSpec,
} from "../admin-bulk/index.js";
import { startMockShopify, type MockOptions, type MockShopify, type VirtualClock } from "./support/mock-shopify.js";
import { collectionGid, productGid, virtualClient } from "./support/helpers.js";

let dir: string;
let clock: VirtualClock;
let mock: MockShopify | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bulk-lab-"));
  clock = { t: 0 };
});
afterEach(async () => {
  await mock?.close();
  mock = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const care = (owner: string, value: string, type = "single_line_text_field") => ({
  ownerId: owner,
  namespace: "custom",
  key: "care",
  type,
  value,
});

async function start(over: Partial<MockOptions> = {}) {
  mock = await startMockShopify({ clock, products: {}, ...over });
  return mock;
}

function products(n: number, existing: Record<number, string> = {}) {
  const out: MockOptions["products"] = {};
  for (let i = 1; i <= n; i++) {
    const old = existing[i];
    out[productGid(i)] = old ? { "custom.care": { value: old, type: "single_line_text_field" } } : {};
  }
  return out;
}

describe("dry run", () => {
  it("prints a diff and writes nothing, not even a checkpoint", async () => {
    const m = await start({ products: products(3, { 2: "Old text", 3: "Same text" }) });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: [care(productGid(1), "New text"), care(productGid(2), "Fresh text"), care(productGid(3), "Same text")],
      collectionAdds: [],
    };
    const checkpointPath = join(dir, "cp.json");
    const report = await runBulk({ client, spec, mode: "dry-run", checkpointPath });

    expect(report.status).toBe("dry_run");
    expect(report.diff).toEqual([
      `+ metafield   ${productGid(1)} custom.care = "New text" (single_line_text_field)`,
      `~ metafield   ${productGid(2)} custom.care: "Old text" -> "Fresh text"`,
    ]);
    expect(report.counts).toMatchObject({ planned: 3, create: 1, update: 1, unchanged: 1, applied: 0, mutationCalls: 0 });
    expect(m.mutationRequestCount()).toBe(0);
    expect(m.products[productGid(1)]).toEqual({});
    expect(existsSync(checkpointPath)).toBe(false);
  });
});

describe("apply", () => {
  it("writes the planned changes and reports them", async () => {
    const m = await start({ products: products(3, { 2: "Old text" }) });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: [care(productGid(1), "A"), care(productGid(2), "B"), care(productGid(3), "C")],
      collectionAdds: [],
    };
    const report = await runBulk({ client, spec, mode: "apply" });

    expect(report.status).toBe("complete");
    expect(report.counts).toMatchObject({ create: 2, update: 1, applied: 3, failed: 0, mutationCalls: 1 });
    expect(m.products[productGid(1)]?.["custom.care"]?.value).toBe("A");
    expect(m.products[productGid(2)]?.["custom.care"]?.value).toBe("B");
  });

  it("a rerun of the same spec is a no-op: zero mutation requests", async () => {
    const m = await start({ products: products(4) });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: [1, 2, 3, 4].map((n) => care(productGid(n), `v${n}`)),
      collectionAdds: [],
    };
    const first = await runBulk({ client, spec, mode: "apply" });
    expect(first.counts.applied).toBe(4);
    const before = m.mutationRequestCount();

    const second = await runBulk({ client, spec, mode: "apply" });
    expect(second.status).toBe("complete");
    expect(second.counts).toMatchObject({ unchanged: 4, create: 0, update: 0, applied: 0, mutationCalls: 0 });
    expect(m.mutationRequestCount()).toBe(before);
  });

  it("splits writes into batches of the configured size", async () => {
    const m = await start({ products: products(60) });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: Array.from({ length: 60 }, (_, i) => care(productGid(i + 1), `v${i}`)),
      collectionAdds: [],
    };
    const report = await runBulk({ client, spec, mode: "apply" });
    expect(report.counts.mutationCalls).toBe(3);
    const sizes = m.requests
      .filter((r) => r.operationName === "MetafieldsSet")
      .map((r) => (r.variables.metafields as unknown[]).length);
    expect(sizes).toEqual([25, 25, 10]);
  });

  it("treats a changed metafield type as an update, even when the value matches", async () => {
    const m = await start({ products: { [productGid(1)]: { "custom.care": { value: "5", type: "single_line_text_field" } } } });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = { metafields: [care(productGid(1), "5", "number_integer")], collectionAdds: [] };
    const report = await runBulk({ client, spec, mode: "dry-run" });
    expect(report.counts.update).toBe(1);
    expect(report.diff[0]).toContain("(type single_line_text_field -> number_integer)");
  });

  it("compares json metafields as data, so key order and spacing do not cause rewrites", async () => {
    expect(valuesEqual("json", '{"a":1,"b":[1,2]}', '{ "b": [1, 2], "a": 1 }')).toBe(true);
    expect(valuesEqual("json", '{"a":1}', '{"a":2}')).toBe(false);
    expect(valuesEqual("single_line_text_field", '{"a":1}', '{ "a": 1 }')).toBe(false);
  });

  it("reports a missing product as a failure and still applies the rest", async () => {
    const m = await start({ products: products(1) });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: [care(productGid(1), "A"), care(productGid(99), "B")],
      collectionAdds: [],
    };
    const report = await runBulk({ client, spec, mode: "apply" });
    expect(report.status).toBe("completed_with_errors");
    expect(report.counts).toMatchObject({ applied: 1, missing: 1, failed: 1 });
    expect(report.diff).toContain(`! metafield   ${productGid(99)} custom.care: product not found`);
  });

  it("isolates one rejected value: the rest of its batch is still written", async () => {
    const m = await start({ products: products(3), rejectValues: ["BAD"] });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: [care(productGid(1), "ok-1"), care(productGid(2), "BAD"), care(productGid(3), "ok-3")],
      collectionAdds: [],
    };
    const report = await runBulk({ client, spec, mode: "apply" });
    expect(report.status).toBe("completed_with_errors");
    expect(report.counts).toMatchObject({ applied: 2, failed: 1 });
    expect(report.failures).toEqual([{ key: `mf|${productGid(2)}|custom.care`, message: "Rejected: BAD" }]);
    expect(m.products[productGid(1)]?.["custom.care"]?.value).toBe("ok-1");
    expect(m.products[productGid(3)]?.["custom.care"]?.value).toBe("ok-3");
    expect(m.products[productGid(2)]).toEqual({});
  });

  it("rejects a spec with duplicate operations before sending anything", async () => {
    const m = await start({ products: products(1) });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = { metafields: [care(productGid(1), "A"), care(productGid(1), "B")], collectionAdds: [] };
    await expect(runBulk({ client, spec, mode: "apply" })).rejects.toBeInstanceOf(SpecError);
    expect(m.requests).toHaveLength(0);
  });

  it("does not put the access token in the report or in error text", async () => {
    const m = await start({ products: products(1), token: "super-secret-token-value" });
    const { client } = virtualClient(m, clock);
    const reportPath = join(dir, "report.json");
    await runBulk({ client, spec: { metafields: [care(productGid(1), "A")], collectionAdds: [] }, mode: "apply", reportPath });
    const text = readFileSync(reportPath, "utf8");
    expect(text).not.toContain("super-secret-token-value");
    expect(JSON.parse(text).status).toBe("complete");

    const { client: wrongToken } = virtualClient({ ...m, token: "wrong" }, clock);
    const err = await wrongToken.request("CurrentMetafield", "query", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminHttpError);
    expect(String(err)).not.toContain("wrong");
    expect((err as AdminHttpError).status).toBe(401);
  });
});

describe("collections", () => {
  it("adds only missing members and reads membership across pages", async () => {
    const m = await start({
      products: products(5),
      collections: { [collectionGid(1)]: [productGid(1), productGid(2), productGid(3)] },
    });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: [],
      collectionAdds: [1, 2, 3, 4, 5].map((n) => ({ collectionId: collectionGid(1), productId: productGid(n) })),
    };
    const dry = await runBulk({ client, spec, mode: "dry-run", batchSizes: { collectionPage: 2 } });
    expect(dry.counts).toMatchObject({ unchanged: 3, create: 2 });
    expect(m.requests.filter((r) => r.operationName === "CollectionMembers")).toHaveLength(2);

    const applied = await runBulk({ client, spec, mode: "apply", batchSizes: { collectionPage: 2 } });
    expect(applied.counts.applied).toBe(2);
    expect(m.collections[collectionGid(1)]).toEqual([1, 2, 3, 4, 5].map(productGid));

    const rerun = await runBulk({ client, spec, mode: "apply" });
    expect(rerun.counts).toMatchObject({ unchanged: 5, applied: 0, mutationCalls: 0 });
  });

  it("batches product ids per collection", async () => {
    const m = await start({ products: products(5), collections: { [collectionGid(1)]: [] } });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: [],
      collectionAdds: [1, 2, 3, 4, 5].map((n) => ({ collectionId: collectionGid(1), productId: productGid(n) })),
    };
    const report = await runBulk({ client, spec, mode: "apply", batchSizes: { collectionProducts: 2 } });
    expect(report.counts.mutationCalls).toBe(3);
  });

  it("reports a missing collection as a failure", async () => {
    const m = await start({ products: products(1) });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: [],
      collectionAdds: [{ collectionId: collectionGid(7), productId: productGid(1) }],
    };
    const report = await runBulk({ client, spec, mode: "apply" });
    expect(report.status).toBe("completed_with_errors");
    expect(report.counts.missing).toBe(1);
  });
});

describe("throttling", () => {
  it("waits before a request when the bucket is below the last known cost", async () => {
    // Bucket 100, refill 50 per second, every call costs 40: the third call finds 20 left.
    const m = await start({
      products: products(75),
      bucket: { max: 100, restoreRate: 50 },
      cost: { query: 40, mutation: 40 },
    });
    const { client, sleeps } = virtualClient(m, clock);
    for (let i = 0; i < 3; i++) await client.request("CurrentMetafield", "query", { ids: [], namespace: "a", key: "b" });
    expect(sleeps).toEqual([400]); // (40 - 20) / 50 per second = 400 ms
    expect(client.stats()).toMatchObject({ requests: 3, throttledResponses: 0, preemptiveWaits: 1, waitedMs: 400 });
  });

  it("waits out a THROTTLED response using the reported shortfall, then retries", async () => {
    const m = await start({
      products: products(1),
      bucket: { max: 100, restoreRate: 20, start: 10 },
      cost: { query: 40, mutation: 40 },
    });
    const { client, sleeps } = virtualClient(m, clock);
    const data = await client.request<{ nodes: unknown[] }>("CurrentMetafield", "query", {
      ids: [productGid(1)],
      namespace: "custom",
      key: "care",
    });
    expect(data.nodes).toHaveLength(1);
    expect(sleeps).toEqual([1500]); // (40 - 10) / 20 per second
    expect(client.stats()).toMatchObject({ requests: 2, throttledResponses: 1 });
  });

  it("gives up with ThrottleError after maxThrottleRetries waits", async () => {
    const m = await start({ products: products(1), alwaysThrottle: true });
    const { client, sleeps } = virtualClient(m, clock, { maxThrottleRetries: 2 });
    await expect(client.request("CurrentMetafield", "query", {})).rejects.toBeInstanceOf(ThrottleError);
    expect(sleeps).toHaveLength(2);
    expect(client.stats().requests).toBe(3);
  });

  it("a large run through a small bucket completes and the report shows the waiting", async () => {
    const m = await start({
      products: products(100),
      bucket: { max: 60, restoreRate: 30 },
      cost: { query: 20, mutation: 25 },
    });
    const { client } = virtualClient(m, clock);
    const spec: BulkSpec = {
      metafields: Array.from({ length: 100 }, (_, i) => care(productGid(i + 1), `v${i}`)),
      collectionAdds: [],
    };
    const report = await runBulk({ client, spec, mode: "apply", batchSizes: { metafields: 10, reads: 50 } });
    expect(report.status).toBe("complete");
    expect(report.counts.applied).toBe(100);
    expect(report.client.waitedMs).toBeGreaterThan(0);
    expect(Object.keys(m.products).every((id) => m.products[id]?.["custom.care"])).toBe(true);
  });
});

describe("checkpoint and resume", () => {
  const spec = (): BulkSpec => ({
    metafields: Array.from({ length: 6 }, (_, i) => care(productGid(i + 1), `v${i + 1}`)),
    collectionAdds: [],
  });

  it("saves progress when the API fails mid-run, then resumes without redoing finished batches", async () => {
    const checkpointPath = join(dir, "cp.json");
    const firstMock = await start({ products: products(6), failMutationNumber: 2 });
    const first = await runBulk({
      client: virtualClient(firstMock, clock).client,
      spec: spec(),
      mode: "apply",
      checkpointPath,
      batchSizes: { metafields: 2 },
    });
    expect(first.status).toBe("aborted");
    expect(first.abortReason).toBe("Admin API returned HTTP 500");
    expect(first.counts.applied).toBe(2);
    expect(JSON.parse(readFileSync(checkpointPath, "utf8")).completed).toHaveLength(2);

    // Same data, healthy API. The first two products were already written.
    const store = firstMock.products;
    await firstMock.close();
    mock = await startMockShopify({ clock, products: store });
    const resumed = await runBulk({
      client: virtualClient(mock, clock).client,
      spec: spec(),
      mode: "apply",
      checkpointPath,
      batchSizes: { metafields: 2 },
    });
    expect(resumed.status).toBe("complete");
    expect(resumed.counts).toMatchObject({ checkpointed: 2, applied: 4, mutationCalls: 2 });
    // The checkpointed owners were not even read again.
    const readIds = mock.requests.filter((r) => r.operationName === "CurrentMetafield").flatMap((r) => r.variables.ids as string[]);
    expect(readIds).toEqual([3, 4, 5, 6].map(productGid));
    expect(existsSync(checkpointPath)).toBe(false);
  });

  it("refuses to resume a checkpoint that belongs to a different spec", async () => {
    const checkpointPath = join(dir, "cp.json");
    const m = await start({ products: products(6), failMutationNumber: 2 });
    const { client } = virtualClient(m, clock);
    await runBulk({ client, spec: spec(), mode: "apply", checkpointPath, batchSizes: { metafields: 2 } });

    const other: BulkSpec = { metafields: [care(productGid(1), "different")], collectionAdds: [] };
    await expect(runBulk({ client, spec: other, mode: "apply", checkpointPath })).rejects.toBeInstanceOf(
      CheckpointMismatchError,
    );
  });

  it("keeps the checkpoint when some items failed, so a rerun retries only those", async () => {
    const checkpointPath = join(dir, "cp.json");
    const m = await start({ products: products(2), rejectValues: ["BAD"] });
    const { client } = virtualClient(m, clock);
    const s: BulkSpec = { metafields: [care(productGid(1), "ok"), care(productGid(2), "BAD")], collectionAdds: [] };
    const report = await runBulk({ client, spec: s, mode: "apply", checkpointPath });
    expect(report.status).toBe("completed_with_errors");
    expect(JSON.parse(readFileSync(checkpointPath, "utf8")).completed).toEqual([`mf|${productGid(1)}|custom.care`]);
  });
});
