/**
 * GraphQL documents. The shapes follow Shopify's documented Admin API
 * (nodes, metafieldsSet, collectionAddProducts). They are exercised here only
 * against a local mock, never against a live Shopify API.
 */

export const CURRENT_METAFIELD = `#graphql
query CurrentMetafield($ids: [ID!]!, $namespace: String!, $key: String!) {
  nodes(ids: $ids) {
    ... on Product {
      id
      metafield(namespace: $namespace, key: $key) {
        value
        type
      }
    }
  }
}`;

export const COLLECTION_MEMBERS = `#graphql
query CollectionMembers($id: ID!, $first: Int!, $after: String) {
  collection(id: $id) {
    id
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
      }
    }
  }
}`;

export const METAFIELDS_SET = `#graphql
mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields {
      id
      namespace
      key
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

export const COLLECTION_ADD_PRODUCTS = `#graphql
mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
  collectionAddProducts(id: $id, productIds: $productIds) {
    collection {
      id
    }
    userErrors {
      field
      message
    }
  }
}`;

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}
