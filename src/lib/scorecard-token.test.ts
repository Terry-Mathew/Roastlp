import { describe, expect, it } from "vitest";

import {
  createScorecardToken,
  verifyScorecardToken,
  SCORECARD_TOKEN_TTL_SECONDS,
} from "./scorecard-token";

const KEY = "scorecard-hmac-key";
const ROAST_ID = "9b5246f1-469d-41e1-b07d-6878eea9cf0c";
const NOW = new Date("2026-08-23T12:00:00Z");

describe("POR-24 scorecard image tokens", () => {
  it("issues short-lived signed tokens that verify within their window", () => {
    const token = createScorecardToken(KEY, ROAST_ID, NOW);
    const payload = verifyScorecardToken(token, KEY, NOW);
    expect(payload?.roastId).toBe(ROAST_ID);

    const nearExpiry = new Date(
      NOW.getTime() + (SCORECARD_TOKEN_TTL_SECONDS - 10) * 1000,
    );
    expect(verifyScorecardToken(token, KEY, nearExpiry)?.roastId).toBe(
      ROAST_ID,
    );
  });

  it("rejects expired tokens", () => {
    const token = createScorecardToken(KEY, ROAST_ID, NOW);
    const afterExpiry = new Date(
      NOW.getTime() + (SCORECARD_TOKEN_TTL_SECONDS + 60) * 1000,
    );
    expect(verifyScorecardToken(token, KEY, afterExpiry)).toBeUndefined();
  });

  it("rejects forged signatures, wrong keys and malformed input", () => {
    const token = createScorecardToken(KEY, ROAST_ID, NOW);
    const [payload, exp, signature] = token.split(".");
    expect(
      verifyScorecardToken(`${payload}.${exp}.${signature}x`, KEY, NOW),
    ).toBeUndefined();
    expect(verifyScorecardToken(token, "other-key", NOW)).toBeUndefined();
    expect(verifyScorecardToken("garbage", KEY, NOW)).toBeUndefined();
    // A validly-signed token for a different roast must not pass as this one.
    const otherRoast = "00000000-0000-4000-8000-00000000beef";
    const other = createScorecardToken(KEY, otherRoast, NOW);
    expect(verifyScorecardToken(other, KEY, NOW)?.roastId).toBe(otherRoast);
  });
});
