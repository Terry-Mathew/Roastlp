import { z } from "zod";
import type { WebhookRepository } from "../db/webhook-repository";
import {
  CapturedPaymentConflictError,
  WebhookCollisionError,
} from "../db/webhook-repository";
import type { RazorpayReconciliationProvider } from "./razorpay-reconciliation";
import type { SanitizedRazorpayEvent } from "./razorpay-webhook";

export class RetryableWebhookError extends Error {}

export interface WebhookServiceDependencies {
  repository: WebhookRepository;
  provider: RazorpayReconciliationProvider;
  now?: () => Date;
}

export type ParsedWebhook =
  | { supported: true; event: SanitizedRazorpayEvent }
  | { supported: false; eventType: string; providerCreatedAt: number };

const storedPayloadSchema = z.object({
  paymentId: z
    .string()
    .regex(/^pay_[A-Za-z0-9]+$/)
    .max(64),
  orderId: z
    .string()
    .regex(/^order_[A-Za-z0-9]+$/)
    .max(64),
  status: z.enum(["captured", "failed"]),
  amount: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  captured: z.boolean(),
  providerCreatedAt: z.number().int().nonnegative(),
});

function safePayload(parsed: ParsedWebhook): Record<string, unknown> {
  if (!parsed.supported)
    return {
      eventType: parsed.eventType,
      providerCreatedAt: parsed.providerCreatedAt,
    };
  return {
    paymentId: parsed.event.paymentId,
    orderId: parsed.event.orderId,
    status: parsed.event.status,
    amount: parsed.event.amount,
    currency: parsed.event.currency,
    captured: parsed.event.captured,
    providerCreatedAt: parsed.event.providerCreatedAt,
  };
}

export async function ingestRazorpayWebhook(
  providerEventId: string,
  digest: string,
  parsed: ParsedWebhook,
  repository: WebhookRepository,
) {
  const eventType = parsed.supported
    ? parsed.event.eventType
    : parsed.eventType;
  const ledger = await repository.recordVerified({
    providerEventId,
    eventType,
    payloadDigest: digest,
    verifiedPayload: safePayload(parsed),
  });
  if (ledger.state === "processed" || ledger.state === "rejected")
    return { status: "DUPLICATE" as const };
  if (!parsed.supported) {
    if (await repository.claim(ledger.id))
      await repository.reject(ledger.id, "UNSUPPORTED_EVENT");
    return { status: "IGNORED" as const };
  }
  return { status: "ACCEPTED" as const, eventId: ledger.id };
}

export async function processStoredRazorpayWebhook(
  eventId: string,
  deps: WebhookServiceDependencies,
) {
  const stored = await deps.repository.findEvent(eventId);
  if (!stored) return { status: "MISSING" as const };
  if (stored.state === "processed" || stored.state === "rejected")
    return { status: "DUPLICATE" as const };
  if (!(await deps.repository.claim(stored.id)))
    return { status: "DUPLICATE" as const };
  if (
    !["payment.captured", "order.paid", "payment.failed"].includes(
      stored.eventType,
    )
  ) {
    await deps.repository.reject(stored.id, "UNSUPPORTED_EVENT");
    return { status: "IGNORED" as const };
  }
  const payload = storedPayloadSchema.safeParse(stored.verifiedPayload);
  if (!payload.success) {
    await deps.repository.reject(stored.id, "INVALID_STORED_EVENT");
    return { status: "REJECTED" as const };
  }
  const event: SanitizedRazorpayEvent = {
    eventType: stored.eventType as SanitizedRazorpayEvent["eventType"],
    ...payload.data,
  };

  if (event.eventType === "payment.failed") {
    // Razorpay documents failed -> captured as a valid late/retry sequence.
    await deps.repository.completeInformational(stored.id);
    return { status: "RECORDED" as const };
  }

  const expected = await deps.repository.findExpectedPayment(event.orderId);
  if (!expected) {
    await deps.repository.reject(stored.id, "UNKNOWN_ORDER");
    return { status: "REJECTED" as const };
  }
  if (
    event.amount !== expected.amountPaise ||
    event.currency !== expected.currency ||
    (expected.razorpayPaymentId &&
      expected.razorpayPaymentId !== event.paymentId)
  ) {
    await deps.repository.reject(stored.id, "WEBHOOK_RECONCILIATION_MISMATCH");
    return { status: "REJECTED" as const };
  }

  try {
    const [payment, order] = await Promise.all([
      deps.provider.fetchPayment(event.paymentId),
      deps.provider.fetchOrder(event.orderId),
    ]);
    const reconciled =
      payment.id === event.paymentId &&
      payment.order_id === expected.razorpayOrderId &&
      payment.status === "captured" &&
      payment.captured &&
      payment.amount === expected.amountPaise &&
      payment.amount_captured === expected.amountPaise &&
      payment.currency === expected.currency &&
      order.id === expected.razorpayOrderId &&
      order.status === "paid" &&
      order.amount === expected.amountPaise &&
      order.amount_paid === expected.amountPaise &&
      order.amount_due === 0 &&
      order.currency === expected.currency &&
      order.receipt === expected.receipt;
    if (!reconciled) {
      await deps.repository.reject(stored.id, "API_RECONCILIATION_MISMATCH");
      return { status: "REJECTED" as const };
    }
    await deps.repository.completeCaptured(
      stored.id,
      expected.razorpayOrderId,
      event.paymentId,
      (deps.now ?? (() => new Date()))(),
    );
    return { status: "CAPTURED" as const };
  } catch (error) {
    if (error instanceof WebhookCollisionError) throw error;
    if (error instanceof CapturedPaymentConflictError) {
      await deps.repository.reject(stored.id, "CAPTURED_PAYMENT_CONFLICT");
      return { status: "REJECTED" as const };
    }
    await deps.repository.fail(
      stored.id,
      "PROVIDER_RECONCILIATION_UNAVAILABLE",
    );
    throw new RetryableWebhookError("Payment reconciliation is unavailable");
  }
}

// Test/convenience composition. Public HTTP ingestion calls ingest only.
export async function processRazorpayWebhook(
  providerEventId: string,
  digest: string,
  parsed: ParsedWebhook,
  deps: WebhookServiceDependencies,
) {
  const ingested = await ingestRazorpayWebhook(
    providerEventId,
    digest,
    parsed,
    deps.repository,
  );
  if (ingested.status !== "ACCEPTED") return ingested;
  return processStoredRazorpayWebhook(ingested.eventId, deps);
}
