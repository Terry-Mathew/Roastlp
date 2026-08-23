import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .max(128);
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
  "payment.captured" | "order.paid" | "payment.failed";

export interface SanitizedRazorpayEvent {
  eventType: SupportedRazorpayEvent;
  paymentId: string;
  orderId: string;
  status: "captured" | "failed";
  amount: number;
  currency: string;
  captured: boolean;
  providerCreatedAt: number;
}

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
  if (
    !["payment.captured", "order.paid", "payment.failed"].includes(
      envelope.event,
    )
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
      eventType: envelope.event as SupportedRazorpayEvent,
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
