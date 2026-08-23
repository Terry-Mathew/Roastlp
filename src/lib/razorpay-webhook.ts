import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .max(128);
const refundEntitySchema = z
  .object({
    id: z
      .string()
      .regex(/^rfnd_[A-Za-z0-9]+$/)
      .max(64),
    entity: z.literal("refund"),
    payment_id: z
      .string()
      .regex(/^pay_[A-Za-z0-9]+$/)
      .max(64),
    status: z.enum(["pending", "processed", "failed"]),
  })
  .passthrough();

const paymentEntitySchema = z
  .object({
    id: z
      .string()
      .regex(/^pay_[A-Za-z0-9]+$/)
      .max(64),
    entity: z.literal("payment"),
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: z.enum(["authorized", "captured", "failed"]),
    order_id: z
      .string()
      .regex(/^order_[A-Za-z0-9]+$/)
      .max(64),
    captured: z.boolean(),
  })
  .passthrough();

const envelopeSchema = z
  .object({
    entity: z.literal("event"),
    event: z.string().min(1).max(128),
    created_at: z.number().int().nonnegative(),
    payload: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export type SupportedRazorpayEvent =
  | "payment.captured"
  | "order.paid"
  | "payment.failed"
  | "refund.processed"
  | "refund.failed";

export interface SanitizedPaymentEvent {
  eventType: "payment.captured" | "order.paid" | "payment.failed";
  paymentId: string;
  orderId: string;
  status: "captured" | "failed";
  amount: number;
  currency: string;
  captured: boolean;
  providerCreatedAt: number;
}

export interface SanitizedRefundEvent {
  eventType: "refund.processed" | "refund.failed";
  refundId: string;
  paymentId: string;
  providerCreatedAt: number;
}

export type SanitizedRazorpayEvent =
  SanitizedPaymentEvent | SanitizedRefundEvent;

export function payloadDigest(rawBody: Uint8Array) {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function validWebhookSignature(
  rawBody: Uint8Array,
  receivedHex: string,
  secrets: readonly string[],
) {
  if (!/^[a-f0-9]{64}$/.test(receivedHex) || secrets.length === 0) return false;
  const received = Buffer.from(receivedHex, "hex");
  let valid = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    valid = timingSafeEqual(received, expected) || valid;
  }
  return valid;
}

export function parseRazorpayWebhook(
  rawBody: Uint8Array,
):
  | { supported: true; event: SanitizedRazorpayEvent }
  | { supported: false; eventType: string; providerCreatedAt: number } {
  const raw: unknown = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  const envelope = envelopeSchema.parse(raw);
  const REFUND_EVENTS = ["refund.processed", "refund.failed"] as const;
  const PAYMENT_EVENTS = [
    "payment.captured",
    "order.paid",
    "payment.failed",
  ] as const;

  if (
    REFUND_EVENTS.includes(envelope.event as (typeof REFUND_EVENTS)[number])
  ) {
    const refundContainer = z
      .object({ entity: refundEntitySchema })
      .passthrough()
      .parse(envelope.payload.refund);
    const refund = refundContainer.entity;
    const expectedStatus =
      envelope.event === "refund.processed" ? "processed" : "failed";
    if (refund.status !== expectedStatus)
      throw new Error("Webhook event and refund snapshot disagree");
    return {
      supported: true,
      event: {
        eventType: envelope.event as SanitizedRefundEvent["eventType"],
        refundId: refund.id,
        paymentId: refund.payment_id,
        providerCreatedAt: envelope.created_at,
      },
    };
  }

  if (
    !PAYMENT_EVENTS.includes(envelope.event as (typeof PAYMENT_EVENTS)[number])
  )
    return {
      supported: false,
      eventType: envelope.event,
      providerCreatedAt: envelope.created_at,
    };

  const paymentContainer = z
    .object({ entity: paymentEntitySchema })
    .passthrough()
    .parse(envelope.payload.payment);
  const payment = paymentContainer.entity;
  const capturedEvent =
    envelope.event === "payment.captured" || envelope.event === "order.paid";
  if (
    capturedEvent
      ? payment.status !== "captured" || !payment.captured
      : payment.status !== "failed" || payment.captured
  )
    throw new Error("Webhook event and payment snapshot disagree");

  return {
    supported: true,
    event: {
      eventType: envelope.event as SanitizedPaymentEvent["eventType"],
      paymentId: payment.id,
      orderId: payment.order_id,
      status: payment.status as "captured" | "failed",
      amount: payment.amount,
      currency: payment.currency,
      captured: payment.captured,
      providerCreatedAt: envelope.created_at,
    },
  };
}

export { identifier as razorpayEventIdSchema };
