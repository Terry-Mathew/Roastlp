import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * POR-22: the report view key is a deterministic 256-bit capability derived
 * from a server-held secret and the roast id (W3C capability-URL model).
 *
 * - Only its SHA-256 hash is ever stored (report_access_grants.token_hash).
 * - The payer receives it once in the checkout response; the same value later
 *   rides in the private report URL and the delivery email.
 * - Compromise recovery = revoke the grant; a support flow can mint a fresh
 *   secret-scoped key by rotating the domain tag.
 */
const DOMAIN = "report-view-key-v1";

export function deriveReportViewKey(hmacKey: string, roastId: string): string {
  return createHmac("sha256", hmacKey)
    .update(`${DOMAIN}:${roastId}`)
    .digest("base64url");
}

export function isValidViewKeyFormat(key: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(key);
}

export function verifyReportViewKey(
  presented: string,
  hmacKey: string,
  roastId: string,
): boolean {
  if (!isValidViewKeyFormat(presented)) return false;
  const expected = Buffer.from(deriveReportViewKey(hmacKey, roastId), "utf8");
  const actual = Buffer.from(presented, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
