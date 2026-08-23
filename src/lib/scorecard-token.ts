import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * POR-24: short-lived signed scorecard tokens. They authorize rendering the
 * public-safe scorecard PNG without exposing or extending the long-lived
 * report capability URL.
 *
 * Format: base64url(roastId).base64url(expSeconds).base64url(HMAC)
 */
const DOMAIN = "scorecard-token-v1";
export const SCORECARD_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

function sign(payload: string, hmacKey: string): string {
  return createHmac("sha256", hmacKey)
    .update(`${DOMAIN}:${payload}`)
    .digest("base64url");
}

export function createScorecardToken(
  hmacKey: string,
  roastId: string,
  now = new Date(),
): string {
  const exp = Math.floor(now.getTime() / 1000) + SCORECARD_TOKEN_TTL_SECONDS;
  const payload = `${Buffer.from(roastId).toString("base64url")}.${exp}`;
  return `${payload}.${sign(payload, hmacKey)}`;
}

export interface ScorecardTokenPayload {
  roastId: string;
}

/** Returns undefined for expired, malformed, or forged tokens. */
export function verifyScorecardToken(
  token: string,
  hmacKey: string,
  now = new Date(),
): ScorecardTokenPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [encodedRoastId, encodedExp, signature] = parts;
  if (!encodedRoastId || !encodedExp || !signature) return undefined;

  const payload = `${encodedRoastId}.${encodedExp}`;
  const expected = Buffer.from(sign(payload, hmacKey), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  )
    return undefined;

  const expSeconds = Number(encodedExp);
  if (!Number.isInteger(expSeconds) || expSeconds * 1000 <= now.getTime())
    return undefined;

  const roastId = Buffer.from(encodedRoastId, "base64url").toString("utf8");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      roastId,
    )
  )
    return undefined;
  return { roastId };
}
