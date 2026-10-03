/** One product metafield that should hold a given value. */
export interface MetafieldChange {
  /** Product global id, for example gid://shopify/Product/123 */
  ownerId: string;
  namespace: string;
  key: string;
  /** Metafield type, for example single_line_text_field or json */
  type: string;
  value: string;
}

/** One product that should be a member of a manual collection. */
export interface CollectionAdd {
  collectionId: string;
  productId: string;
}

export interface BulkSpec {
  metafields: MetafieldChange[];
  collectionAdds: CollectionAdd[];
}

export interface BatchSizes {
  /** metafieldsSet accepts up to 25 metafields per call. */
  metafields: number;
  /** collectionAddProducts accepts up to 250 product ids per call. */
  collectionProducts: number;
  /** Owners read per nodes() query. */
  reads: number;
  /** Members read per collection page. */
  collectionPage: number;
}

export const DEFAULT_BATCH_SIZES: BatchSizes = {
  metafields: 25,
  collectionProducts: 250,
  reads: 100,
  collectionPage: 250,
};

export const metafieldKey = (c: Pick<MetafieldChange, "ownerId" | "namespace" | "key">): string =>
  `mf|${c.ownerId}|${c.namespace}.${c.key}`;

export const collectionKey = (c: CollectionAdd): string => `col|${c.collectionId}|${c.productId}`;
