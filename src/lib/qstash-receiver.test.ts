import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { QStashReceiver, QStashSignatureError } from "./qstash-receiver";

const CURRENT_KEY = "sign-key-current";
const NEXT_KEY = "sign-key-next";
const URL = "https://roastmylp.example/api/audit-jobs/run";

function signToken(payload: object, key: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function validToken(rawBody: string, key = CURRENT_KEY, claims = {}) {
  return signToken(
    {
      iss: "Upstash",
      sub: URL,
      exp: Math.floor(Date.now() / 1000) + 300,
      nbf: Math.floor(Date.now() / 1000) - 10,
      body: createHash("sha256").update(rawBody).digest("hex"),
      ...claims,
    },
    key,
  );
}

describe("POR-17 QStash delivery signature verification", () => {
  const receiver = new QStashReceiver(CURRENT_KEY, NEXT_KEY);
  const rawBody = JSON.stringify({
    jobId: "b3bb2df0-0f6e-4a1e-9c1d-2f4a5b6c7d8e",
  });

  it("accepts a current-key signature over the exact raw body", () => {
    expect(() =>
      receiver.verify({
        body: rawBody,
        signature: validToken(rawBody),
        url: URL,
      }),
    ).not.toThrow();
  });

  it("accepts the next signing key during rolls", () => {
    expect(() =>
      receiver.verify({
        body: rawBody,
        signature: validToken(rawBody, NEXT_KEY),
        url: URL,
      }),
    ).not.toThrow();
  });

  it("rejects any body tampering", () => {
    expect(() =>
      receiver.verify({
        body: `${rawBody} `,
        signature: validToken(rawBody),
        url: URL,
      }),
    ).toThrow(QStashSignatureError);
  });

  it("rejects expired tokens and foreign issuers", () => {
    expect(() =>
      receiver.verify({
        body: rawBody,
        signature: validToken(rawBody, CURRENT_KEY, {
          exp: Math.floor(Date.now() / 1000) - 1,
        }),
        url: URL,
      }),
    ).toThrow(QStashSignatureError);
    expect(() =>
      receiver.verify({
        body: rawBody,
        signature: validToken(rawBody, CURRENT_KEY, { iss: "Attacker" }),
        url: URL,
      }),
    ).toThrow(QStashSignatureError);
  });

  it("rejects signatures from unknown keys", () => {
    expect(() =>
      receiver.verify({
        body: rawBody,
        signature: validToken(rawBody, "attacker-key"),
        url: URL,
      }),
    ).toThrow(QStashSignatureError);
  });
});
