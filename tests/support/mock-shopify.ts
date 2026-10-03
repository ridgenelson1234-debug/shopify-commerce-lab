import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the Admin GraphQL endpoint. It routes on operationName
 * (it does not parse GraphQL), keeps products and collections in memory, and
 * models the cost bucket with a virtual clock so throttle tests need no real waiting.
 * It is only as faithful as the shapes documented in admin-bulk/queries.ts.
 */

export interface VirtualClock {
  t: number;
}

export interface MockOptions {
  token?: string;
  clock: VirtualClock;
  /** product id -> "namespace.key" -> metafield */
  products: Record<string, Record<string, { value: string; type: string }>>;
  /** collection id -> member product ids */
  collections?: Record<string, string[]>;
  bucket?: { max: number; restoreRate: number; start?: number };
  cost?: { query: number; mutation: number };
  /** Make the nth mutation request (1-based, counted after throttling) answer HTTP 500. */
  failMutationNumber?: number;
  /** Metafield values the mock rejects with a userError (whole call rejected, nothing written). */
  rejectValues?: string[];
  /** Answer THROTTLED to every request regardless of the bucket. */
  alwaysThrottle?: boolean;
}

export interface MockRequest {
  operationName: string;
  variables: Record<string, unknown>;
}

export interface MockShopify {
  url: string;
  token: string;
  requests: MockRequest[];
  /** Mutation requests that reached the handler (not counting THROTTLED answers). */
  mutationCount: () => number;
  /** Mutation requests of any outcome, including THROTTLED. */
  mutationRequestCount: () => number;
  products: MockOptions["products"];
  collections: Record<string, string[]>;
  close: () => Promise<void>;
}

const MUTATIONS = new Set(["MetafieldsSet", "CollectionAddProducts"]);

async function readJson(req: IncomingMessage): Promise<MockRequest & { query: string }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startMockShopify(opts: MockOptions): Promise<MockShopify> {
  const token = opts.token ?? "test-token-not-real";
  const bucketCfg = opts.bucket ?? { max: 1000, restoreRate: 50 };
  const cost = opts.cost ?? { query: 10, mutation: 10 };
  const collections = opts.collections ?? {};
  const requests: MockRequest[] = [];
  let mutationsHandled = 0;
  let mutationRequests = 0;

  let available = bucketCfg.start ?? bucketCfg.max;
  let lastRefill = opts.clock.t;
  const refill = () => {
    available = Math.min(bucketCfg.max, available + (bucketCfg.restoreRate * (opts.clock.t - lastRefill)) / 1000);
    lastRefill = opts.clock.t;
  };
  const status = () => ({
    maximumAvailable: bucketCfg.max,
    currentlyAvailable: available,
    restoreRate: bucketCfg.restoreRate,
  });

  const server: Server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-shopify-access-token"] !== token) return send(401, { errors: "unauthorized" });

    const body = await readJson(req);
    const { operationName, variables } = body;
    requests.push({ operationName, variables });
    const isMutation = MUTATIONS.has(operationName);
    if (isMutation) mutationRequests++;

    refill();
    const requested = isMutation ? cost.mutation : cost.query;
    if (opts.alwaysThrottle || requested > available) {
      return send(200, {
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: { requestedQueryCost: requested, actualQueryCost: null, throttleStatus: status() } },
      });
    }
    available -= requested;
    const extensions = {
      cost: { requestedQueryCost: requested, actualQueryCost: requested, throttleStatus: status() },
    };

    if (isMutation) {
      mutationsHandled++;
      if (opts.failMutationNumber === mutationsHandled) return send(500, { errors: "boom" });
    }

    switch (operationName) {
      case "CurrentMetafield": {
        const { ids, namespace, key } = variables as { ids: string[]; namespace: string; key: string };
        const nodes = ids.map((id) => {
          const product = opts.products[id];
          return product ? { id, metafield: product[`${namespace}.${key}`] ?? null } : null;
        });
        return send(200, { data: { nodes }, extensions });
      }
      case "CollectionMembers": {
        const { id, first, after } = variables as { id: string; first: number; after: string | null };
        const members = collections[id];
        if (!members) return send(200, { data: { collection: null }, extensions });
        const start = after ? Number(after) : 0;
        const page = members.slice(start, start + first);
        const end = start + page.length;
        return send(200, {
          data: {
            collection: {
              id,
              products: {
                pageInfo: { hasNextPage: end < members.length, endCursor: String(end) },
                nodes: page.map((pid) => ({ id: pid })),
              },
            },
          },
          extensions,
        });
      }
      case "MetafieldsSet": {
        const { metafields } = variables as {
          metafields: { ownerId: string; namespace: string; key: string; type: string; value: string }[];
        };
        const userErrors: { field: string[]; message: string; code: string }[] = [];
        metafields.forEach((m, i) => {
          if (!opts.products[m.ownerId]) {
            userErrors.push({ field: ["metafields", String(i), "ownerId"], message: "Owner not found", code: "INVALID" });
          } else if (opts.rejectValues?.includes(m.value)) {
            userErrors.push({ field: ["metafields", String(i), "value"], message: `Rejected: ${m.value}`, code: "INVALID" });
          }
        });
        if (userErrors.length === 0) {
          for (const m of metafields) {
            const owner = opts.products[m.ownerId];
            if (owner) owner[`${m.namespace}.${m.key}`] = { value: m.value, type: m.type };
          }
        }
        return send(200, {
          data: { metafieldsSet: { metafields: userErrors.length ? [] : metafields.map((m) => ({ key: m.key })), userErrors } },
          extensions,
        });
      }
      case "CollectionAddProducts": {
        const { id, productIds } = variables as { id: string; productIds: string[] };
        const members = collections[id];
        if (!members) {
          return send(200, {
            data: { collectionAddProducts: { collection: null, userErrors: [{ field: ["id"], message: "Collection not found" }] } },
            extensions,
          });
        }
        for (const pid of productIds) if (!members.includes(pid)) members.push(pid);
        return send(200, { data: { collectionAddProducts: { collection: { id }, userErrors: [] } }, extensions });
      }
      default:
        return send(200, { errors: [{ message: `unknown operation ${operationName}` }], extensions });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/admin/api/test/graphql.json`,
    token,
    requests,
    mutationCount: () => mutationsHandled,
    mutationRequestCount: () => mutationRequests,
    products: opts.products,
    collections,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
