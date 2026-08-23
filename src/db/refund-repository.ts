import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "./client";
import {
  auditJobs,
  payments,
  refunds,
  roasts,
  type RefundRecord,
} from "./schema";
import { assertStateTransition, refundTransitions } from "./states";

export interface CapturedPaymentForRoast {
  id: string;
  roastId: string;
  razorpayPaymentId: string;
  amountPaise: number;
}

export class DrizzleRefundRepository {
  constructor(private db: Database) {}

  /**
   * Inserts the refund request keyed by the Razorpay idempotency key. A lost
   * race returns the winner's row so duplicate deliveries converge on one
   * refund.
   */
  async createRequested(
    input: {
      paymentId: string;
      idempotencyKey: string;
      reasonCode: string;
      amountPaise: number;
    },
    now = new Date(),
  ): Promise<{ refund: RefundRecord; created: boolean }> {
    const [inserted] = await this.db
      .insert(refunds)
      .values({
        paymentId: input.paymentId,
        state: "requested",
        idempotencyKey: input.idempotencyKey,
        reasonCode: input.reasonCode,
        amountPaise: input.amountPaise,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: refunds.idempotencyKey })
      .returning();
    if (inserted) return { refund: inserted, created: true };
    const existing = await this.db.query.refunds.findFirst({
      where: eq(refunds.idempotencyKey, input.idempotencyKey),
    });
    if (!existing) throw new Error("Refund request could not be recorded");
    return { refund: existing, created: false };
  }

  async findById(id: string): Promise<RefundRecord | undefined> {
    return this.db.query.refunds.findFirst({ where: eq(refunds.id, id) });
  }

  async findByRazorpayRefundId(
    refundId: string,
  ): Promise<RefundRecord | undefined> {
    return this.db.query.refunds.findFirst({
      where: eq(refunds.razorpayRefundId, refundId),
    });
  }

  /** requested -> processing once Razorpay accepted the request. */
  async attachProcessing(
    id: string,
    razorpayRefundId: string,
    now = new Date(),
  ): Promise<void> {
    const current = await this.findById(id);
    if (!current) throw new Error("Refund disappeared before attach");
    assertStateTransition(
      "refund",
      refundTransitions,
      current.state,
      "processing",
    );
    await this.db
      .update(refunds)
      .set({
        state: "processing",
        razorpayRefundId,
        updatedAt: now,
      })
      .where(and(eq(refunds.id, id), eq(refunds.state, current.state)));
  }

  /** Records the provider refund id without a state change. */
  async recordProviderRefundId(
    id: string,
    razorpayRefundId: string,
    now = new Date(),
  ): Promise<void> {
    await this.db
      .update(refunds)
      .set({ razorpayRefundId, updatedAt: now })
      .where(eq(refunds.id, id));
  }

  async paymentById(paymentRowId: string) {
    return this.db.query.payments.findFirst({
      where: eq(payments.id, paymentRowId),
      columns: { id: true, roastId: true },
    });
  }

  async markSucceeded(id: string, now = new Date()): Promise<void> {
    await this.transitionTerminal(id, "succeeded", null, now);
  }

  async markFailed(
    id: string,
    errorCode: string,
    now = new Date(),
  ): Promise<void> {
    await this.transitionTerminal(id, "failed", errorCode, now);
  }

  private async transitionTerminal(
    id: string,
    next: "succeeded" | "failed",
    errorCode: string | null,
    now: Date,
  ): Promise<void> {
    const current = await this.findById(id);
    if (!current) throw new Error("Refund disappeared before terminal update");
    if (current.state === next && next === "succeeded") return;
    assertStateTransition("refund", refundTransitions, current.state, next);
    await this.db
      .update(refunds)
      .set({
        state: next,
        errorCode,
        completedAt: next === "succeeded" ? now : null,
        updatedAt: now,
      })
      .where(and(eq(refunds.id, id), eq(refunds.state, current.state)));
  }

  async findUnsettled(limit: number): Promise<RefundRecord[]> {
    return this.db
      .select()
      .from(refunds)
      .where(inArray(refunds.state, ["requested", "processing"]))
      .orderBy(refunds.createdAt)
      .limit(limit);
  }

  async capturedPaymentForRoast(
    roastId: string,
  ): Promise<CapturedPaymentForRoast | undefined> {
    const payment = await this.db.query.payments.findFirst({
      where: and(eq(payments.roastId, roastId), eq(payments.state, "captured")),
      columns: {
        id: true,
        roastId: true,
        razorpayPaymentId: true,
        amountPaise: true,
      },
    });
    if (!payment?.razorpayPaymentId) return undefined;
    return {
      id: payment.id,
      roastId: payment.roastId,
      razorpayPaymentId: payment.razorpayPaymentId,
      amountPaise: payment.amountPaise,
    };
  }

  /** ready_for_fulfillment/queued/processing/terminal_failure -> refund_pending. */
  async moveRoastToRefundPending(roastId: string): Promise<boolean> {
    const [moved] = await this.db
      .update(roasts)
      .set({ state: "refund_pending", updatedAt: new Date() })
      .where(
        and(
          eq(roasts.id, roastId),
          inArray(roasts.state, [
            "ready_for_fulfillment",
            "queued",
            "processing",
            "terminal_failure",
          ]),
        ),
      )
      .returning({ id: roasts.id });
    return Boolean(moved);
  }

  /** refund_pending -> refunded (idempotent when already refunded). */
  async settleRoastRefunded(roastId: string): Promise<boolean> {
    const [settled] = await this.db
      .update(roasts)
      .set({ state: "refunded", updatedAt: new Date() })
      .where(and(eq(roasts.id, roastId), eq(roasts.state, "refund_pending")))
      .returning({ id: roasts.id });
    return Boolean(settled);
  }

  /** captured -> refunded on confirmed provider settlement. */
  async markPaymentRefunded(paymentRowId: string): Promise<void> {
    await this.db
      .update(payments)
      .set({ state: "refunded", updatedAt: new Date() })
      .where(
        and(eq(payments.id, paymentRowId), eq(payments.state, "captured")),
      );
  }

  /** Loads the roast for an audit job (terminal-failure entry point). */
  async roastIdForJob(jobId: string): Promise<string | undefined> {
    const job = await this.db.query.auditJobs.findFirst({
      where: eq(auditJobs.id, jobId),
      columns: { roastId: true },
    });
    return job?.roastId;
  }
}
