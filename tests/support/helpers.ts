import { createAdminClient, type AdminClient } from "../../admin-bulk/index.js";
import type { MockShopify, VirtualClock } from "./mock-shopify.js";

/** A client whose sleep() advances the mock's virtual clock instead of waiting. */
export function virtualClient(mock: MockShopify, clock: VirtualClock, extra: { maxThrottleRetries?: number } = {}) {
  const sleeps: number[] = [];
  const client: AdminClient = createAdminClient({
    endpoint: mock.url,
    accessToken: mock.token,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
    ...extra,
  });
  return { client, sleeps };
}

export const productGid = (n: number) => `gid://shopify/Product/${n}`;
export const collectionGid = (n: number) => `gid://shopify/Collection/${n}`;
