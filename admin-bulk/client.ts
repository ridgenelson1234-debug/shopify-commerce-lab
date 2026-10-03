/**
 * Minimal Admin GraphQL client with cost-based throttling.
 *
 * Shopify reports a query cost bucket in `extensions.cost.throttleStatus`:
 * `maximumAvailable`, `currentlyAvailable` and `restoreRate` (points per
 * second). The client does two things with it:
 *  1. before a request, if the bucket is estimated to be below the cost this
 *     operation had last time, wait for it to refill;
 *  2. if a response carries a THROTTLED error, wait for the shortfall and retry,
 *     up to maxThrottleRetries times.
 */

export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class AdminHttpError extends AdminError {
  readonly status: number;
  constructor(status: number) {
    super(`Admin API returned HTTP ${status}`);
    this.status = status;
  }
}
export class AdminNetworkError extends AdminError {}
export class AdminGraphQLError extends AdminError {
  readonly messages: string[];
  constructor(messages: string[]) {
    super(`GraphQL errors: ${messages.join("; ")}`);
    this.messages = messages;
  }
}
export class ThrottleError extends AdminError {}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface CostExtension {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
  throttleStatus?: ThrottleStatus;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: CostExtension };
}

export interface ClientStats {
  requests: number;
  throttledResponses: number;
  preemptiveWaits: number;
  waitedMs: number;
}

export interface AdminClientConfig {
  /** Full GraphQL URL, for example https://example-store.myshopify.com/admin/api/<version>/graphql.json */
  endpoint: string;
  accessToken: string;
  maxThrottleRetries?: number;
  /** Wait used when a THROTTLED response gives no usable cost data. */
  fallbackThrottleWaitMs?: number;
  fetchImpl?: typeof fetch;
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface AdminClient {
  request<T>(operationName: string, query: string, variables?: Record<string, unknown>): Promise<T>;
  stats(): ClientStats;
}

export function adminEndpoint(shopDomain: string, apiVersion: string): string {
  return `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAdminClient(config: AdminClientConfig): AdminClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? realSleep;
  const now = config.now ?? Date.now;
  const maxThrottleRetries = config.maxThrottleRetries ?? 5;
  const fallbackWaitMs = config.fallbackThrottleWaitMs ?? 1000;

  const counters: ClientStats = { requests: 0, throttledResponses: 0, preemptiveWaits: 0, waitedMs: 0 };
  const lastCost = new Map<string, number>();
  let bucket: { status: ThrottleStatus; at: number } | null = null;

  const pause = async (ms: number) => {
    counters.waitedMs += ms;
    await sleep(ms);
  };

  const estimatedAvailable = (): number | null => {
    if (!bucket) return null;
    const { status, at } = bucket;
    const refilled = (status.restoreRate * (now() - at)) / 1000;
    return Math.min(status.maximumAvailable, status.currentlyAvailable + refilled);
  };

  const shortfallMs = (cost: number, available: number, restoreRate: number): number =>
    restoreRate > 0 ? Math.ceil(((cost - available) / restoreRate) * 1000) : fallbackWaitMs;

  const record = (operationName: string, cost: CostExtension | undefined) => {
    if (!cost) return;
    if (typeof cost.requestedQueryCost === "number") lastCost.set(operationName, cost.requestedQueryCost);
    if (cost.throttleStatus) bucket = { status: cost.throttleStatus, at: now() };
  };

  const waitForBudget = async (operationName: string) => {
    const cost = lastCost.get(operationName);
    const available = estimatedAvailable();
    if (cost === undefined || available === null || !bucket || available >= cost) return;
    counters.preemptiveWaits++;
    await pause(shortfallMs(cost, available, bucket.status.restoreRate));
  };

  const post = async <T>(operationName: string, query: string, variables: Record<string, unknown>) => {
    let res: Response;
    try {
      res = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-access-token": config.accessToken },
        body: JSON.stringify({ operationName, query, variables }),
      });
    } catch (err) {
      throw new AdminNetworkError(`network request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new AdminHttpError(res.status);
    try {
      return (await res.json()) as GraphQLResponse<T>;
    } catch {
      throw new AdminError("Admin API returned a body that is not JSON");
    }
  };

  async function request<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    let throttleRetries = 0;
    for (;;) {
      await waitForBudget(operationName);
      counters.requests++;
      const body = await post<T>(operationName, query, variables);
      const cost = body.extensions?.cost;
      record(operationName, cost);

      const errors = body.errors ?? [];
      if (errors.some((e) => e.extensions?.code === "THROTTLED")) {
        counters.throttledResponses++;
        if (throttleRetries >= maxThrottleRetries) {
          throw new ThrottleError(`still throttled after ${maxThrottleRetries} waits (${operationName})`);
        }
        throttleRetries++;
        const status = cost?.throttleStatus;
        const needed = cost?.requestedQueryCost;
        const wait =
          status && typeof needed === "number" && needed > status.currentlyAvailable
            ? shortfallMs(needed, status.currentlyAvailable, status.restoreRate)
            : fallbackWaitMs;
        await pause(wait);
        continue;
      }
      if (errors.length > 0) throw new AdminGraphQLError(errors.map((e) => e.message));
      if (body.data == null) throw new AdminGraphQLError(["response had no data"]);
      return body.data;
    }
  }

  return { request, stats: () => ({ ...counters }) };
}
