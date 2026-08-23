import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createAuditJobRoute } from "./route-handler";

const CURRENT_KEY = "current-key";
const NEXT_KEY = "next-key";
const WORKER_URL = "https://app.example/api/audit-jobs/run";

function signedToken(rawBody: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "Upstash",
      sub: WORKER_URL,
      exp: Math.floor(Date.now() / 1000) + 300,
      body: createHash("sha256").update(rawBody).digest("hex"),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", CURRENT_KEY)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function post(body: string, signature?: string) {
  return new Request(WORKER_URL, {
    method: "POST",
    headers: signature ? { "upstash-signature": signature } : {},
    body,
  });
}

describe("POR-17 audit worker boundary", () => {
  it("refuses deliveries while the audit pipeline is unconfigured, consuming nothing", async () => {
    const handler = createAuditJobRoute(null, {
      databaseUrl: "postgres://unused",
      qstashCurrentSigningKey: CURRENT_KEY,
      qstashNextSigningKey: NEXT_KEY,
    });
    const raw = JSON.stringify({
      jobId: "00000000-0000-4000-8000-000000000000",
    });
    const response = await handler(post(raw, signedToken(raw)));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AUDIT_PIPELINE_UNCONFIGURED",
    });
  });

  it("rejects missing and invalid signatures with 401", async () => {
    const handler = createAuditJobRoute(
      async () => ({
        classification: "succeeded",
      }),
      {
        databaseUrl: "postgres://unused",
        qstashCurrentSigningKey: CURRENT_KEY,
        qstashNextSigningKey: NEXT_KEY,
      },
    );

    const missing = await handler(post("{}"));
    expect(missing.status).toBe(401);

    const invalid = await handler(post("{}", "not.a.jwt"));
    expect(invalid.status).toBe(401);
    expect(((await invalid.json()) as { error: string }).error).toBe(
      "INVALID_SIGNATURE",
    );
  });

  it("reports unavailable rather than processing when environment is incomplete", async () => {
    const handler = createAuditJobRoute(
      async () => ({
        classification: "succeeded",
      }),
      {},
    );
    const response = await handler(post("{}", undefined));
    expect(response.status).toBe(503);
  });
});
