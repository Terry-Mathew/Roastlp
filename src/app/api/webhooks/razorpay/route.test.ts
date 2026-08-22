import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const names = [
  "DATABASE_URL",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
] as const;
const previous = Object.fromEntries(
  names.map((name) => [name, process.env[name]]),
);
const keySecretFixture = ["key", "fixture", "por15"].join("-");
const webhookSecretFixture = ["webhook", "fixture", "por15"].join("-");

describe("POR-15 Razorpay webhook HTTP boundary", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://unused.invalid/test";
    process.env.RAZORPAY_KEY_ID = "rzp_test_boundary";
    process.env.RAZORPAY_KEY_SECRET = keySecretFixture;
    process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecretFixture;
  });
  afterEach(() => {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("rejects non-JSON and declared oversized bodies before configuration use", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost/api/webhooks/razorpay", {
            method: "POST",
            body: "x",
          }),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await POST(
          new Request("http://localhost/api/webhooks/razorpay", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": "200000",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(413);
  });

  it("fails closed when configuration or authenticated headers are missing", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const unavailable = await POST(
      new Request("http://localhost/api/webhooks/razorpay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");

    process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecretFixture;
    const invalid = await POST(
      new Request("http://localhost/api/webhooks/razorpay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "INVALID_WEBHOOK" });
  });

  it("rejects a forged signature before parsing or opening the database", async () => {
    const body = Buffer.from("not even json");
    const signature = createHmac("sha256", "wrong-secret")
      .update(body)
      .digest("hex");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(
      new Request("http://localhost/api/webhooks/razorpay", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-razorpay-event-id": "evt_boundary_1",
          "x-razorpay-signature": signature,
        },
        body,
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_WEBHOOK" });
    expect(warning).toHaveBeenCalledOnce();
    const emitted = String(warning.mock.calls[0]?.[0]);
    expect(emitted).toContain("razorpay_webhook_signature_rejected");
    expect(emitted).not.toContain(body.toString("utf8"));
    expect(emitted).not.toContain(signature);
    warning.mockRestore();
  });
});
