import { createAdminClient, runBulk, type BulkSpec } from "../admin-bulk/index.js";
import { startMockShopify, type VirtualClock } from "../tests/support/mock-shopify.js";

/**
 * Runs the bulk updater three times against the local mock: dry run, apply,
 * rerun. No network beyond 127.0.0.1, no credentials.
 */
async function main() {
  const clock: VirtualClock = { t: 0 };
  const gid = (kind: string, n: number) => `gid://shopify/${kind}/${n}`;
  const mock = await startMockShopify({
    clock,
    products: {
      [gid("Product", 1)]: {},
      [gid("Product", 2)]: { "custom.care": { value: "Wash warm", type: "single_line_text_field" } },
      [gid("Product", 3)]: { "custom.care": { value: "Wash cold", type: "single_line_text_field" } },
    },
    collections: { [gid("Collection", 10)]: [gid("Product", 3)] },
    bucket: { max: 100, restoreRate: 50 },
    cost: { query: 40, mutation: 40 },
  });

  const client = createAdminClient({
    endpoint: mock.url,
    accessToken: mock.token,
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
  });

  const care = (n: number, value: string) => ({
    ownerId: gid("Product", n),
    namespace: "custom",
    key: "care",
    type: "single_line_text_field",
    value,
  });
  const spec: BulkSpec = {
    metafields: [care(1, "Wash cold"), care(2, "Wash cold"), care(3, "Wash cold")],
    collectionAdds: [1, 2, 3].map((n) => ({ collectionId: gid("Collection", 10), productId: gid("Product", n) })),
  };

  const runs = [
    { label: "1. dry run", mode: "dry-run" },
    { label: "2. apply", mode: "apply" },
    { label: "3. rerun of the same spec", mode: "apply" },
  ] as const;

  for (const { label, mode } of runs) {
    const report = await runBulk({ client, spec, mode });
    console.log(`\n== ${label}: status=${report.status}`);
    for (const line of report.diff) console.log(`   ${line}`);
    if (report.diff.length === 0) console.log("   (no differences)");
    console.log(`   counts: ${JSON.stringify(report.counts)}`);
    console.log(`   client (cumulative): ${JSON.stringify(report.client)}`);
  }
  await mock.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
