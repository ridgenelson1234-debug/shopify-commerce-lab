import { writeFileSync } from "node:fs";
import { AdminError, type AdminClient, type ClientStats } from "./client.js";
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { formatDiff } from "./diff.js";
import { buildPlan, type PlanItem } from "./plan.js";
import { COLLECTION_ADD_PRODUCTS, METAFIELDS_SET, type UserError } from "./queries.js";
import { specHash, validateSpec } from "./spec.js";
import { DEFAULT_BATCH_SIZES, type BatchSizes, type BulkSpec } from "./types.js";

export type RunMode = "dry-run" | "apply";
export type RunStatus = "dry_run" | "complete" | "completed_with_errors" | "aborted";

export interface BulkReport {
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  specHash: string;
  counts: {
    planned: number;
    create: number;
    update: number;
    unchanged: number;
    checkpointed: number;
    missing: number;
    applied: number;
    failed: number;
    mutationCalls: number;
  };
  /** Request and throttle counters from the client, including total time spent waiting. */
  client: ClientStats;
  diff: string[];
  failures: { key: string; message: string }[];
  abortReason?: string;
}

export interface RunOptions {
  client: AdminClient;
  spec: BulkSpec;
  mode: RunMode;
  /** Progress file. Loaded if present, updated after every successful batch, removed when the run completes cleanly. */
  checkpointPath?: string;
  reportPath?: string;
  batchSizes?: Partial<BatchSizes>;
  now?: () => Date;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const describe = (errors: UserError[]) => errors.map((e) => e.message).join("; ");

interface MetafieldsSetData {
  metafieldsSet: { userErrors: UserError[] };
}
interface CollectionAddData {
  collectionAddProducts: { userErrors: UserError[] };
}

export async function runBulk(options: RunOptions): Promise<BulkReport> {
  const { client, spec, mode } = options;
  const now = options.now ?? (() => new Date());
  const sizes: BatchSizes = { ...DEFAULT_BATCH_SIZES, ...options.batchSizes };
  const startedAt = now().toISOString();

  validateSpec(spec);
  const hash = specHash(spec);
  const done = new Set(loadCheckpoint(options.checkpointPath, hash));

  const failures: { key: string; message: string }[] = [];
  let applied = 0;
  let mutationCalls = 0;
  let plan: PlanItem[] = [];
  let status: RunStatus = mode === "dry-run" ? "dry_run" : "complete";
  let abortReason: string | undefined;

  const markDone = (keys: string[]) => {
    for (const key of keys) done.add(key);
    applied += keys.length;
    if (options.checkpointPath) saveCheckpoint(options.checkpointPath, hash, done, now());
  };

  /** Send one batch. If Shopify rejects it, retry each item alone so one bad value fails only itself. */
  async function sendBatch(
    items: PlanItem[],
    call: (batch: PlanItem[]) => Promise<UserError[]>,
  ): Promise<void> {
    mutationCalls++;
    const errors = await call(items);
    if (errors.length === 0) return markDone(items.map((i) => i.key));
    if (items.length === 1) {
      const only = items[0];
      if (only) failures.push({ key: only.key, message: describe(errors) });
      return;
    }
    for (const item of items) await sendBatch([item], call);
  }

  const callMetafields = async (batch: PlanItem[]): Promise<UserError[]> => {
    const metafields = batch.flatMap((i) =>
      i.kind === "metafield"
        ? [{ ownerId: i.change.ownerId, namespace: i.change.namespace, key: i.change.key, type: i.change.type, value: i.change.value }]
        : [],
    );
    const data = await client.request<MetafieldsSetData>("MetafieldsSet", METAFIELDS_SET, { metafields });
    return data.metafieldsSet.userErrors;
  };

  const callCollection = (collectionId: string) => async (batch: PlanItem[]): Promise<UserError[]> => {
    const productIds = batch.flatMap((i) => (i.kind === "collection" ? [i.change.productId] : []));
    const data = await client.request<CollectionAddData>("CollectionAddProducts", COLLECTION_ADD_PRODUCTS, {
      id: collectionId,
      productIds,
    });
    return data.collectionAddProducts.userErrors;
  };

  try {
    plan = await buildPlan(client, spec, done, sizes);

    for (const item of plan) {
      if (item.action === "missing") {
        failures.push({ key: item.key, message: "target not found" });
      }
    }

    if (mode === "apply") {
      const writable = plan.filter((i) => i.action === "create" || i.action === "update");

      const metafieldItems = writable.filter((i) => i.kind === "metafield");
      for (const batch of chunk(metafieldItems, sizes.metafields)) await sendBatch(batch, callMetafields);

      const byCollection = new Map<string, PlanItem[]>();
      for (const item of writable) {
        if (item.kind !== "collection") continue;
        byCollection.set(item.change.collectionId, [...(byCollection.get(item.change.collectionId) ?? []), item]);
      }
      for (const [collectionId, items] of byCollection) {
        for (const batch of chunk(items, sizes.collectionProducts)) {
          await sendBatch(batch, callCollection(collectionId));
        }
      }
      if (failures.length > 0) status = "completed_with_errors";
    }
  } catch (err) {
    // API-level failures (HTTP, network, GraphQL, throttle give-up) end the run
    // with progress saved. Anything else is a bug and is rethrown.
    if (!(err instanceof AdminError)) throw err;
    status = "aborted";
    abortReason = err.message;
  }

  const count = (action: PlanItem["action"]) => plan.filter((i) => i.action === action).length;
  const report: BulkReport = {
    mode,
    status,
    startedAt,
    finishedAt: now().toISOString(),
    specHash: hash,
    counts: {
      planned: spec.metafields.length + spec.collectionAdds.length,
      create: count("create"),
      update: count("update"),
      unchanged: count("unchanged"),
      checkpointed: count("checkpointed"),
      missing: count("missing"),
      applied,
      failed: failures.length,
      mutationCalls,
    },
    client: client.stats(),
    diff: formatDiff(plan),
    failures,
    ...(abortReason ? { abortReason } : {}),
  };

  if (mode === "apply" && status === "complete") clearCheckpoint(options.checkpointPath);
  if (options.reportPath) writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
