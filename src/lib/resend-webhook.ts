import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * POR-25: Svix signature verification for Resend webhook deliveries.
 *
 * Resend signs each delivery as HMAC-SHA256 over `${id}.${timestamp}.${body}`
 * using the base64 secret behind the whsec_ prefixed signing secret, and
 * sends the resulting signatures (space-separated) in `svix-signature`.
 */
const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export class SvixVerificationError extends Error {
  constructor(
    readonly code: "MISSING_HEADERS" | "STALE_TIMESTAMP" | "BAD_SIGNATURE",
  ) {
    super(`Svix verification failed: ${code}`);
    this.name = "SvixVerificationError";
  }
}

function sign(
  payloadId: string,
  timestamp: string,
  body: string,
  secret: string,
): string {
  const normalized = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  const key = Buffer.from(normalized, "base64");
  return createHmac("sha256", key)
    .update(`${payloadId}.${timestamp}.${body}`)
    .digest("base64");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifySvixSignature(
  headers: SvixHeaders,
  rawBody: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature)
    throw new SvixVerificationError("MISSING_HEADERS");

  const deliveredAt = Number(timestamp);
  if (!Number.isFinite(deliveredAt))
    throw new SvixVerificationError("STALE_TIMESTAMP");
  if (Math.abs(now - deliveredAt) > SVIX_TOLERANCE_SECONDS)
    throw new SvixVerificationError("STALE_TIMESTAMP");

  const expected = sign(id, timestamp, rawBody, secret);
  const presented = signature.split(" ").filter(Boolean);
  if (!presented.some((candidate) => constantTimeEquals(expected, candidate)))
    throw new SvixVerificationError("BAD_SIGNATURE");
}

/** Fixed allowlist of handled Resend event types; everything else is a no-op. */
export const HANDLED_RESEND_EVENTS = [
  "email.bounced",
  "email.complained",
] as const;
