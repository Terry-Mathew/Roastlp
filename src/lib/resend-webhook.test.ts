import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SvixVerificationError, verifySvixSignature } from "./resend-webhook";

const SECRET = `whsec_${randomBytes(16).toString("base64")}`;

function signedHeaders(
  body: string,
  secret = SECRET,
  timestampOffsetSeconds = 0,
  tamperSignature = false,
) {
  const timestamp = Math.floor(Date.now() / 1000) + timestampOffsetSeconds;
  const id = "msg_test_0001";
  const signature = createHmac(
    "sha256",
    Buffer.from(secret.replace(/^whsec_/, ""), "base64"),
  )
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    id,
    timestamp: String(timestamp),
    signature: tamperSignature ? `${signature}x` : signature,
  };
}

describe("POR-25 Svix verification", () => {
  it("accepts a correctly signed fresh delivery", () => {
    const body = JSON.stringify({ type: "email.bounced", data: {} });
    expect(() =>
      verifySvixSignature(signedHeaders(body), body, SECRET),
    ).not.toThrow();
  });

  it("rejects missing headers", () => {
    const body = "{}";
    expect(() =>
      verifySvixSignature(
        { id: null, timestamp: null, signature: null },
        body,
        SECRET,
      ),
    ).toThrow(SvixVerificationError);
  });

  it("rejects stale deliveries beyond the tolerance window", () => {
    const body = "{}";
    expect(() =>
      verifySvixSignature(signedHeaders(body, SECRET, -601), body, SECRET),
    ).toThrow(/STALE_TIMESTAMP/);
  });

  it("rejects tampered payloads and signatures", () => {
    const body = JSON.stringify({ type: "email.bounced" });
    const headers = signedHeaders(body);
    expect(() => verifySvixSignature(headers, `${body} `, SECRET)).toThrow(
      /BAD_SIGNATURE/,
    );
    expect(() =>
      verifySvixSignature(signedHeaders(body, SECRET, 0, true), body, SECRET),
    ).toThrow(/BAD_SIGNATURE/);
  });
});
