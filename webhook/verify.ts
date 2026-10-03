import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shopify signs each webhook with base64(HMAC-SHA256(secret, raw body)) and
 * sends it in X-Shopify-Hmac-Sha256. The signature covers the exact bytes on
 * the wire, so callers must pass the body before any JSON parsing.
 */
export function computeShopifyHmac(rawBody: Uint8Array | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function verifyShopifyHmac(
  rawBody: Uint8Array | string,
  headerValue: string | undefined,
  secret: string,
): boolean {
  if (secret.length === 0) return false;
  if (typeof headerValue !== "string" || headerValue.length === 0) return false;

  const expected = Buffer.from(computeShopifyHmac(rawBody, secret), "utf8");
  const received = Buffer.from(headerValue.trim(), "utf8");
  // timingSafeEqual throws on unequal lengths. A SHA-256 digest in base64 has a
  // fixed length, so rejecting on length leaks nothing an attacker can use.
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
