import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseRazorpayWebhook,
  payloadDigest,
  validWebhookSignature,
} from "./razorpay-webhook";

function payload(
  event:
    | "payment.captured"
    | "payment.failed"
    | "payment.authorized" = "payment.captured",
) {
  const captured = event === "payment.captured";
  return Buffer.from(
    JSON.stringify({
      entity: "event",
      account_id: "acc_testAccount",
      event,
      contains: ["payment"],
      payload: {
        payment: {
          entity: {
            id: "pay_por15Payment1",
            entity: "payment",
            amount: 19_900,
            currency: "INR",
            status: captured
              ? "captured"
              : event === "payment.failed"
                ? "failed"
                : "authorized",
            order_id: "order_por15Order1",
            captured,
            email: "must-not-be-persisted@example.com",
            contact: "+919999999999",
            card: { id: "card_must_not_be_persisted" },
          },
        },
      },
      created_at: 1_787_440_000,
    }),
  );
}

describe("POR-15 Razorpay webhook boundary", () => {
  it("verifies the untouched raw bytes and supports secret rotation", () => {
    const raw = payload();
    const previousSecret = "previous-webhook-secret";
    const signature = createHmac("sha256", previousSecret)
      .update(raw)
      .digest("hex");
    expect(
      validWebhookSignature(raw, signature, [
        "current-webhook-secret",
        previousSecret,
      ]),
    ).toBe(true);
    expect(
      validWebhookSignature(Buffer.concat([raw, Buffer.from(" ")]), signature, [
        previousSecret,
      ]),
    ).toBe(false);
    expect(validWebhookSignature(raw, "not-hex", [previousSecret])).toBe(false);
  });

  it("extracts only reconciliation fields from captured payment payloads", () => {
    const parsed = parseRazorpayWebhook(payload());
    expect(parsed).toEqual({
      supported: true,
      event: {
        eventType: "payment.captured",
        paymentId: "pay_por15Payment1",
        orderId: "order_por15Order1",
        status: "captured",
        amount: 19_900,
        currency: "INR",
        captured: true,
        providerCreatedAt: 1_787_440_000,
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("must-not-be-persisted");
    expect(payloadDigest(payload())).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps failure informational and rejects inconsistent snapshots", () => {
    expect(parseRazorpayWebhook(payload("payment.failed"))).toMatchObject({
      supported: true,
      event: { status: "failed", captured: false },
    });
    const inconsistent = JSON.parse(payload().toString("utf8"));
    inconsistent.payload.payment.entity.status = "authorized";
    expect(() =>
      parseRazorpayWebhook(Buffer.from(JSON.stringify(inconsistent))),
    ).toThrow(/disagree/);
  });

  it("classifies signed but unsubscribed event types without retaining payload", () => {
    expect(parseRazorpayWebhook(payload("payment.authorized"))).toEqual({
      supported: false,
      eventType: "payment.authorized",
      providerCreatedAt: 1_787_440_000,
    });
  });
});
