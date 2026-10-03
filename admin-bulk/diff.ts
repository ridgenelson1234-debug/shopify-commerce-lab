import type { PlanItem } from "./plan.js";

function show(value: string): string {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}..."` : text;
}

/**
 * Human-readable diff of the plan. Unchanged and checkpointed items are left
 * out of the lines and appear only in the report counts.
 */
export function formatDiff(plan: readonly PlanItem[]): string[] {
  const lines: string[] = [];
  for (const item of plan) {
    if (item.action === "unchanged" || item.action === "checkpointed") continue;

    if (item.kind === "metafield") {
      const c = item.change;
      const target = `${c.ownerId} ${c.namespace}.${c.key}`;
      if (item.action === "create") lines.push(`+ metafield   ${target} = ${show(c.value)} (${c.type})`);
      else if (item.action === "update" && item.before) {
        const typeNote = item.before.type === c.type ? "" : ` (type ${item.before.type} -> ${c.type})`;
        lines.push(`~ metafield   ${target}: ${show(item.before.value)} -> ${show(c.value)}${typeNote}`);
      } else if (item.action === "missing") lines.push(`! metafield   ${target}: product not found`);
      continue;
    }

    const c = item.change;
    if (item.action === "create") lines.push(`+ collection  ${c.collectionId} add ${c.productId}`);
    else if (item.action === "missing") lines.push(`! collection  ${c.collectionId}: collection not found`);
  }
  return lines;
}
