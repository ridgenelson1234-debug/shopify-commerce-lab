import type { AdminClient } from "./client.js";
import { COLLECTION_MEMBERS, CURRENT_METAFIELD } from "./queries.js";
import {
  collectionKey,
  metafieldKey,
  type BatchSizes,
  type BulkSpec,
  type CollectionAdd,
  type MetafieldChange,
} from "./types.js";

export type Action = "create" | "update" | "unchanged" | "checkpointed" | "missing";

export interface CurrentMetafield {
  value: string;
  type: string;
}

export type PlanItem =
  | { kind: "metafield"; key: string; action: Action; change: MetafieldChange; before: CurrentMetafield | null }
  | { kind: "collection"; key: string; action: Action; change: CollectionAdd };

/** JSON metafields are compared as data, since Shopify may reformat whitespace and key order. */
export function valuesEqual(type: string, a: string, b: string): boolean {
  if (a === b) return true;
  if (type !== "json") return false;
  try {
    return canonicalJson(JSON.parse(a)) === canonicalJson(JSON.parse(b));
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface CurrentMetafieldData {
  nodes: ({ id: string; metafield: CurrentMetafield | null } | null)[];
}

interface CollectionMembersData {
  collection: {
    id: string;
    products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string }[] };
  } | null;
}

async function planMetafields(
  client: AdminClient,
  changes: MetafieldChange[],
  done: ReadonlySet<string>,
  sizes: BatchSizes,
): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  const toRead = new Map<string, MetafieldChange[]>();

  for (const change of changes) {
    const key = metafieldKey(change);
    if (done.has(key)) {
      items.push({ kind: "metafield", key, action: "checkpointed", change, before: null });
      continue;
    }
    const group = `${change.namespace}\u0000${change.key}`;
    toRead.set(group, [...(toRead.get(group) ?? []), change]);
  }

  for (const group of toRead.values()) {
    const first = group[0];
    if (!first) continue;
    for (const part of chunk(group, sizes.reads)) {
      const data = await client.request<CurrentMetafieldData>("CurrentMetafield", CURRENT_METAFIELD, {
        ids: part.map((c) => c.ownerId),
        namespace: first.namespace,
        key: first.key,
      });
      const byId = new Map<string, CurrentMetafield | null>();
      for (const node of data.nodes) if (node) byId.set(node.id, node.metafield);

      for (const change of part) {
        const key = metafieldKey(change);
        if (!byId.has(change.ownerId)) {
          items.push({ kind: "metafield", key, action: "missing", change, before: null });
          continue;
        }
        const before = byId.get(change.ownerId) ?? null;
        let action: Action = "create";
        if (before) {
          action =
            before.type === change.type && valuesEqual(change.type, before.value, change.value)
              ? "unchanged"
              : "update";
        }
        items.push({ kind: "metafield", key, action, change, before });
      }
    }
  }
  return items;
}

async function readMembers(client: AdminClient, collectionId: string, pageSize: number): Promise<Set<string> | null> {
  const members = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const data: CollectionMembersData = await client.request<CollectionMembersData>(
      "CollectionMembers",
      COLLECTION_MEMBERS,
      { id: collectionId, first: pageSize, after },
    );
    if (!data.collection) return null;
    for (const node of data.collection.products.nodes) members.add(node.id);
    const { hasNextPage, endCursor } = data.collection.products.pageInfo;
    if (!hasNextPage) return members;
    after = endCursor;
  }
}

async function planCollections(
  client: AdminClient,
  changes: CollectionAdd[],
  done: ReadonlySet<string>,
  sizes: BatchSizes,
): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  const byCollection = new Map<string, CollectionAdd[]>();
  for (const change of changes) {
    const key = collectionKey(change);
    if (done.has(key)) {
      items.push({ kind: "collection", key, action: "checkpointed", change });
      continue;
    }
    byCollection.set(change.collectionId, [...(byCollection.get(change.collectionId) ?? []), change]);
  }

  for (const [collectionId, group] of byCollection) {
    const members = await readMembers(client, collectionId, sizes.collectionPage);
    for (const change of group) {
      const key = collectionKey(change);
      const action: Action = members === null ? "missing" : members.has(change.productId) ? "unchanged" : "create";
      items.push({ kind: "collection", key, action, change });
    }
  }
  return items;
}

/** Read current state and decide, per operation, whether a write is needed. Writes nothing. */
export async function buildPlan(
  client: AdminClient,
  spec: BulkSpec,
  done: ReadonlySet<string>,
  sizes: BatchSizes,
): Promise<PlanItem[]> {
  return [
    ...(await planMetafields(client, spec.metafields, done, sizes)),
    ...(await planCollections(client, spec.collectionAdds, done, sizes)),
  ];
}
