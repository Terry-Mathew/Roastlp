import { and, eq, inArray, or } from "drizzle-orm";
import type { Database } from "./client";
import { auditJobs, payments, roasts, webhookEvents } from "./schema";

export interface VerifiedWebhookInput {
  providerEventId: string;
  eventType: string;
  payloadDigest: string;
  verifiedPayload: Record<string, unknown>;
}

export interface WebhookEventView {
  id: string;
  state: "received" | "processing" | "processed" | "failed" | "rejected";
  eventType: string;
  payloadDigest: string;
}

export interface StoredWebhookEvent extends WebhookEventView {
  verifiedPayload: unknown;
}

export interface ExpectedPayment {
  roastId: string;
  state:
    | "created"
    | "authorized"
    | "captured"
    | "failed"
    | "partially_refunded"
    | "refunded";
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  receipt: string;
  amountPaise: number;
  currency: string;
}

export interface WebhookRepository {
  recordVerified(input: VerifiedWebhookInput): Promise<WebhookEventView>;
  findEvent(eventId: string): Promise<StoredWebhookEvent | undefined>;
  claim(eventId: string): Promise<boolean>;
  findExpectedPayment(orderId: string): Promise<ExpectedPayment | undefined>;
  completeCaptured(
    eventId: string,
    orderId: string,
    paymentId: string,
    capturedAt: Date,
  ): Promise<void>;
  completeInformational(eventId: string): Promise<void>;
  reject(eventId: string, errorCode: string): Promise<void>;
  fail(eventId: string, errorCode: string): Promise<void>;
}

export class WebhookCollisionError extends Error {}
export class CapturedPaymentConflictError extends Error {}

export class DrizzleWebhookRepository implements WebhookRepository {
  constructor(private db: Database) {}

  async recordVerified(input: VerifiedWebhookInput) {
    const [inserted] = await this.db
      .insert(webhookEvents)
      .values({ provider: "razorpay", ...input })
      .onConflictDoNothing()
      .returning({
        id: webhookEvents.id,
        state: webhookEvents.state,
        eventType: webhookEvents.eventType,
        payloadDigest: webhookEvents.payloadDigest,
      });
    if (inserted) return inserted;
    const existing = await this.db.query.webhookEvents.findFirst({
      where: and(
        eq(webhookEvents.provider, "razorpay"),
        eq(webhookEvents.providerEventId, input.providerEventId),
      ),
      columns: {
        id: true,
        state: true,
        eventType: true,
        payloadDigest: true,
      },
    });
    if (
      !existing ||
      existing.payloadDigest !== input.payloadDigest ||
      existing.eventType !== input.eventType
    )
      throw new WebhookCollisionError("Webhook event identity collision");
    return existing;
  }

  async claim(eventId: string) {
    const [claimed] = await this.db
      .update(webhookEvents)
      .set({ state: "processing", errorCode: null })
      .where(
        and(
          eq(webhookEvents.id, eventId),
          or(
            eq(webhookEvents.state, "received"),
            eq(webhookEvents.state, "failed"),
            eq(webhookEvents.state, "processing"),
          ),
        ),
      )
      .returning({ id: webhookEvents.id });
    return Boolean(claimed);
  }

  async findEvent(eventId: string) {
    return this.db.query.webhookEvents.findFirst({
      where: eq(webhookEvents.id, eventId),
      columns: {
        id: true,
        state: true,
        eventType: true,
        payloadDigest: true,
        verifiedPayload: true,
      },
    });
  }

  async findExpectedPayment(orderId: string) {
    return this.db.query.payments.findFirst({
      where: eq(payments.razorpayOrderId, orderId),
      columns: {
        roastId: true,
        state: true,
        razorpayOrderId: true,
        razorpayPaymentId: true,
        receipt: true,
        amountPaise: true,
        currency: true,
      },
    });
  }

  async completeCaptured(
    eventId: string,
    orderId: string,
    paymentId: string,
    capturedAt: Date,
  ) {
    await this.db.transaction(async (tx) => {
      const current = await tx.query.payments.findFirst({
        where: eq(payments.razorpayOrderId, orderId),
      });
      if (!current)
        throw new CapturedPaymentConflictError(
          "Captured payment order is unknown",
        );
      if (current.razorpayPaymentId && current.razorpayPaymentId !== paymentId)
        throw new CapturedPaymentConflictError(
          "Captured payment id conflicts with stored payment",
        );

      if (current.state === "created" || current.state === "authorized") {
        const [captured] = await tx
          .update(payments)
          .set({
            state: "captured",
            razorpayPaymentId: paymentId,
            capturedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(payments.id, current.id),
              inArray(payments.state, ["created", "authorized"]),
            ),
          )
          .returning({ id: payments.id });
        if (!captured) {
          const raced = await tx.query.payments.findFirst({
            where: eq(payments.id, current.id),
            columns: { state: true, razorpayPaymentId: true },
          });
          if (
            raced?.state !== "captured" ||
            raced.razorpayPaymentId !== paymentId
          )
            throw new CapturedPaymentConflictError(
              "Concurrent captured payment conflicts with stored payment",
            );
        }
      } else if (
        !["captured", "partially_refunded", "refunded"].includes(current.state)
      ) {
        throw new CapturedPaymentConflictError(
          "Captured event conflicts with stored payment state",
        );
      }

      const [released] = await tx
        .update(roasts)
        .set({ state: "ready_for_fulfillment", updatedAt: new Date() })
        .where(
          and(
            eq(roasts.id, current.roastId),
            eq(roasts.state, "awaiting_payment"),
          ),
        )
        .returning({ id: roasts.id });
      if (released)
        await tx
          .insert(auditJobs)
          .values({ roastId: current.roastId })
          .onConflictDoNothing();

      await tx
        .update(webhookEvents)
        .set({ state: "processed", processedAt: new Date(), errorCode: null })
        .where(
          and(
            eq(webhookEvents.id, eventId),
            eq(webhookEvents.state, "processing"),
          ),
        );
    });
  }

  async completeInformational(eventId: string) {
    await this.finish(eventId, "processed", null);
  }

  async reject(eventId: string, errorCode: string) {
    await this.finish(eventId, "rejected", errorCode);
  }

  async fail(eventId: string, errorCode: string) {
    await this.finish(eventId, "failed", errorCode);
  }

  private async finish(
    eventId: string,
    state: "processed" | "rejected" | "failed",
    errorCode: string | null,
  ) {
    await this.db
      .update(webhookEvents)
      .set({
        state,
        errorCode,
        processedAt: state === "processed" ? new Date() : null,
      })
      .where(
        and(
          eq(webhookEvents.id, eventId),
          eq(webhookEvents.state, "processing"),
        ),
      );
  }
}
