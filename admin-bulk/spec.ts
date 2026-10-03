import { createHash } from "node:crypto";
import { collectionKey, metafieldKey, type BulkSpec } from "./types.js";

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const COLLECTION_GID = /^gid:\/\/shopify\/Collection\/\d+$/;

/** Reject anything that would make a run ambiguous before any request is sent. */
export function validateSpec(spec: BulkSpec): void {
  const seen = new Set<string>();
  const unique = (key: string) => {
    if (seen.has(key)) throw new SpecError(`duplicate operation in spec: ${key}`);
    seen.add(key);
  };

  for (const m of spec.metafields) {
    if (!PRODUCT_GID.test(m.ownerId)) throw new SpecError(`ownerId must be a Product gid: ${m.ownerId}`);
    if (!m.namespace || !m.key || !m.type) throw new SpecError(`namespace, key and type are required: ${m.ownerId}`);
    if (typeof m.value !== "string") throw new SpecError(`value must be a string: ${m.ownerId}`);
    unique(metafieldKey(m));
  }
  for (const c of spec.collectionAdds) {
    if (!COLLECTION_GID.test(c.collectionId)) throw new SpecError(`collectionId must be a Collection gid: ${c.collectionId}`);
    if (!PRODUCT_GID.test(c.productId)) throw new SpecError(`productId must be a Product gid: ${c.productId}`);
    unique(collectionKey(c));
  }
}

/** Stable fingerprint of what a run is asked to do. A checkpoint only resumes the same spec. */
export function specHash(spec: BulkSpec): string {
  const lines = [
    ...spec.metafields.map((m) => `${metafieldKey(m)}|${m.type}|${m.value}`),
    ...spec.collectionAdds.map((c) => collectionKey(c)),
  ].sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
