import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PaymentVerificationRepository } from "../db/checkout-repository";

export const paymentVerificationRequestSchema = z
  .object({
    razorpay_order_id: z
      .string()
      .regex(/^order_[A-Za-z0-9]+$/)
      .max(64),
    razorpay_payment_id: z
      .string()
      .regex(/^pay_[A-Za-z0-9]+$/)
      .max(64),
    razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export class PaymentVerificationError extends Error {}
export class PaymentVerificationConflictError extends Error {}

export interface PaymentVerificationDependencies {
  repository: PaymentVerificationRepository;
  keySecret: string;
}

function validSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string,
) {
  const expected = createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`, "utf8")
    .digest();
  const received = Buffer.from(signature, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export async function verifyCheckoutPayment(
  raw: unknown,
  deps: PaymentVerificationDependencies,
) {
  const input = paymentVerificationRequestSchema.parse(raw);
  const stored = await deps.repository.findPaymentByOrder(
    input.razorpay_order_id,
  );
  if (!stored) throw new PaymentVerificationError("Unknown payment order");
  if (
    !validSignature(
      stored.razorpayOrderId,
      input.razorpay_payment_id,
      input.razorpay_signature,
      deps.keySecret,
    )
  )
    throw new PaymentVerificationError("Invalid payment signature");
  if (stored.state === "failed")
    throw new PaymentVerificationConflictError("Payment already failed");

  try {
    await deps.repository.recordAuthorizedPayment(
      stored.razorpayOrderId,
      input.razorpay_payment_id,
    );
  } catch {
    throw new PaymentVerificationConflictError(
      "Payment conflicts with stored authorization",
    );
  }
  return { status: "PAYMENT_AUTHORIZED" as const };
}
