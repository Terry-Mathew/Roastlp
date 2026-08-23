import type { Database } from "../db/client";
import { DrizzleRefundRepository } from "../db/refund-repository";
import type { RefundRecord } from "../db/schema";
import {
  RefundConflictError,
  RefundRejectedError,
  RefundUnavailableError,
  buildRefundIdempotencyKey,
  type RefundApiClient,
} from "./razorpay-refunds";

export const RECONCILE_BATCH = 25;

export type RefundRequestOutcome =
  | { status: "already_settled" }
  | { status: "pending_provider" }
  | { status: "succeeded" }
  | { status: "retry_scheduled" }
  | { status: "failed_terminal" };

export interface RefundServiceOptions {
  now?: () => Date;
  /**
   * Operational alert sink. Structured and PII-free. Sentry wiring arrives
   * with POR-31; failed refunds stay visible in the ledger until then.
   */
  alert?: (payload: Record<string, unknown>) => void;
}

function defaultAlert(payload: Record<string, unknown>): void {
  console.error(
    JSON.stringify({ event: "REFUND_ACTION_REQUIRED", ...payload }),
  );
}

export class RefundService {
  private repository: DrizzleRefundRepository;

  constructor(
    db: Database,
    private api: RefundApiClient,
    private options: RefundServiceOptions = {},
  ) {
    this.repository = new DrizzleRefundRepository(db);
  }

  /**
   * Requests the single idempotent normal-speed refund for a captured
   * payment. Safe to call repeatedly: the Razorpay idempotency key is
   * derived deterministically from our payment UUID, settled states
   * short-circuit, and open requests are reconciled instead of re-created.
   */
  async requestRefundForPayment(
    input: {
      paymentRowId: string;
      razorpayPaymentId: string;
      amountPaise: number;
    },
    reasonCode = "TERMINAL_AUDIT_FAILURE",
  ): Promise<RefundRequestOutcome> {
    const key = buildRefundIdempotencyKey(input.paymentRowId);
    const { refund } = await this.repository.createRequested(
      {
        paymentId: input.paymentRowId,
        idempotencyKey: key,
        reasonCode,
        amountPaise: input.amountPaise,
      },
      this.now(),
    );

    if (refund.state === "succeeded") return { status: "already_settled" };
    if (refund.state === "failed") {
      // Definitively rejected refunds stay failed for manual resolution;
      // silent automatic retries would mask an operational problem.
      this.alert(refund.id, "REFUND_PREVIOUSLY_FAILED");
      return { status: "failed_terminal" };
    }
    if (refund.razorpayRefundId) return this.syncRefund(refund);

    try {
      const provider = await this.api.create({
        razorpayPaymentId: input.razorpayPaymentId,
        amountPaise: input.amountPaise,
        idempotencyKey: key,
      });
      return await this.applyProviderState(refund, provider);
    } catch (error) {
      if (
        error instanceof RefundConflictError ||
        error instanceof RefundUnavailableError
      )
        // Leave state=requested; reconciler retries with the same key.
        return { status: "retry_scheduled" };
      if (error instanceof RefundRejectedError) {
        const code = `REFUND_REJECTED_${error.status}`;
        await this.repository.markFailed(refund.id, code, this.now());
        this.alert(refund.id, code);
        return { status: "failed_terminal" };
      }
      throw error;
    }
  }

  /** Entry point for terminal audit failures (retries already exhausted). */
  async refundTerminalRoast(
    jobId: string,
  ): Promise<RefundRequestOutcome | { status: "nothing_to_refund" }> {
    const roastId = await this.repository.roastIdForJob(jobId);
    if (!roastId) return { status: "nothing_to_refund" };
    await this.repository.moveRoastToRefundPending(roastId);
    const payment = await this.repository.capturedPaymentForRoast(roastId);
    if (!payment) return { status: "nothing_to_refund" };

    const outcome = await this.requestRefundForPayment({
      paymentRowId: payment.id,
      razorpayPaymentId: payment.razorpayPaymentId,
      amountPaise: payment.amountPaise,
    });
    if (outcome.status === "succeeded")
      await this.settleSucceededSideEffects(payment.id, roastId);
    return outcome;
  }

  /** Reconciles unsettled refunds against the provider until terminal. */
  async reconcileUnsettled(limit = RECONCILE_BATCH): Promise<{
    scanned: number;
    settled: number;
    stillOpen: number;
    retryScheduled: number;
    terminalFailures: number;
  }> {
    const unsettled = await this.repository.findUnsettled(limit);
    let settled = 0;
    let stillOpen = 0;
    let retryScheduled = 0;
    let terminalFailures = 0;

    for (const refund of unsettled) {
      if (!refund.razorpayRefundId) {
        // Never accepted by the provider; a later sweep retries creation.
        retryScheduled += 1;
        continue;
      }
      const outcome = await this.syncRefund(refund);
      switch (outcome.status) {
        case "succeeded":
        case "already_settled":
          settled += 1;
          break;
        case "failed_terminal":
          terminalFailures += 1;
          break;
        case "retry_scheduled":
          retryScheduled += 1;
          break;
        default:
          stillOpen += 1;
      }
    }

    return {
      scanned: unsettled.length,
      settled,
      stillOpen,
      retryScheduled,
      terminalFailures,
    };
  }

  /** Applies authoritative webhook outcomes for a known Razorpay refund id. */
  async applyProviderRefundEvent(
    razorpayRefundId: string,
    outcome: "succeeded" | "failed",
  ): Promise<boolean> {
    const refund =
      await this.repository.findByRazorpayRefundId(razorpayRefundId);
    if (!refund) return false;

    if (outcome === "succeeded") {
      if (refund.state === "requested")
        await this.repository.attachProcessing(
          refund.id,
          razorpayRefundId,
          this.now(),
        );
      if (refund.state !== "succeeded")
        await this.repository.markSucceeded(refund.id, this.now());
      const payment = await this.repository.paymentById(refund.paymentId);
      await this.settleSucceededSideEffects(
        refund.paymentId,
        payment?.roastId ?? null,
      );
      return true;
    }

    if (refund.state !== "failed") {
      await this.repository.markFailed(
        refund.id,
        "PROVIDER_REFUND_FAILED",
        this.now(),
      );
      this.alert(refund.id, "PROVIDER_REFUND_FAILED");
    }
    return true;
  }

  private async syncRefund(
    refund: RefundRecord,
  ): Promise<RefundRequestOutcome> {
    try {
      const provider = await this.api.fetch(refund.razorpayRefundId!);
      return await this.applyProviderState(refund, provider);
    } catch (error) {
      if (
        error instanceof RefundUnavailableError ||
        error instanceof RefundConflictError
      )
        return { status: "retry_scheduled" };
      if (error instanceof RefundRejectedError) {
        const code = `REFUND_LOOKUP_${error.status}`;
        await this.repository.markFailed(refund.id, code, this.now());
        this.alert(refund.id, code);
        return { status: "failed_terminal" };
      }
      throw error;
    }
  }

  private async applyProviderState(
    refund: RefundRecord,
    provider: { id: string; status: "pending" | "processed" | "failed" },
  ): Promise<RefundRequestOutcome> {
    if (!refund.razorpayRefundId)
      await this.repository.recordProviderRefundId(
        refund.id,
        provider.id,
        this.now(),
      );

    if (provider.status === "pending") {
      if (refund.state === "requested")
        await this.repository.attachProcessing(
          refund.id,
          provider.id,
          this.now(),
        );
      return { status: "pending_provider" };
    }

    const current = (await this.repository.findById(refund.id)) ?? refund;

    if (provider.status === "processed") {
      if (current.state === "requested")
        await this.repository.attachProcessing(
          current.id,
          provider.id,
          this.now(),
        );
      await this.repository.markSucceeded(current.id, this.now());
      const payment = await this.repository.paymentById(current.paymentId);
      await this.settleSucceededSideEffects(
        current.paymentId,
        payment?.roastId ?? null,
      );
      return { status: "succeeded" };
    }

    // provider.status === "failed"
    if (current.state !== "failed") {
      await this.repository.markFailed(
        current.id,
        "PROVIDER_REFUND_FAILED",
        this.now(),
      );
      this.alert(current.id, "PROVIDER_REFUND_FAILED");
    }
    return { status: "failed_terminal" };
  }

  private async settleSucceededSideEffects(
    paymentRowId: string,
    roastId: string | null,
  ): Promise<void> {
    await this.repository.markPaymentRefunded(paymentRowId);
    if (!roastId) return;
    // Any active roast state funnels through refund_pending before refunded;
    // already-terminal refunds make this a no-op.
    await this.repository.moveRoastToRefundPending(roastId);
    await this.repository.settleRoastRefunded(roastId);
  }

  private alert(refundId: string | null, code: string): void {
    const sink = this.options.alert ?? defaultAlert;
    sink({ code, refundId });
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
