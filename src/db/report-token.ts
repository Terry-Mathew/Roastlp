import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

export function createReportAccessToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashReportAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyReportAccessToken(
  token: string,
  expectedHash: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashReportAccessToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return timingSafeEqual(actual, expected);
}
