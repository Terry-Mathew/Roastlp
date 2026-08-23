import { describe, expect, it } from "vitest";
import type {
  ExpectedPayment,
  VerifiedWebhookInput,
  WebhookEventView,
  WebhookRepository,
} from "../db/webhook-repository";
import { CapturedPaymentConflictError } from "../db/webhook-repository";
import type {
  RazorpayReconciliationProvider,
  ReconciledOrder,
  ReconciledPayment,
} from "./razorpay-reconciliation";
import type { SanitizedPaymentEvent } from "./razorpay-webhook";
import {
  ingestRazorpayWebhook,
  processRazorpayWebhook,
  RetryableWebhookError,
} from "./webhook-service";

class MemoryRepository implements WebhookRepository {
  ledger: WebhookEventView = {
    id: "019c8ee0-0000-7000-8000-000000000015",
    state: "received",
    eventType: "payment.captured",
    payloadDigest: "a".repeat(64),
  };
  expected: ExpectedPayment | undefined = {
    roastId: "019c8ee0-0000-7000-8000-000000000016",
    state: "authorized",
    razorpayOrderId: "order_por15Order1",
    razorpayPaymentId: "pay_por15Payment1",
    receipt: "r_por15receipt1",
    amountPaise: 19_900,
    currency: "INR",
  };
  recorded: VerifiedWebhookInput | undefined;
  captured = 0;
  informational = 0;
  rejected: string[] = [];
  failed: string[] = [];
  captureError: Error | undefined;

  async recordVerified(input: VerifiedWebhookInput) {
    this.recorded = input;
    this.ledger = {
      ...this.ledger,
      eventType: input.eventType,
      payloadDigest: input.payloadDigest,
    };
    return this.ledger;
  }
  async findEvent() {
    return {
      ...this.ledger,
      verifiedPayload: this.recorded?.verifiedPayload ?? {},
    };
  }
  async claim() {
    if (this.ledger.state !== "received" && this.ledger.state !== "failed")
      return false;
    this.ledger.state = "processing";
    return true;
  }
  async findExpectedPayment() {
    return this.expected;
  }
  async completeCaptured() {
    if (this.captureError) throw this.captureError;
    this.captured += 1;
    this.ledger.state = "processed";
  }
  async completeInformational() {
    this.informational += 1;
    this.ledger.state = "processed";
  }
  async reject(_id: string, code: string) {
    this.rejected.push(code);
    this.ledger.state = "rejected";
  }
  async fail(_id: string, code: string) {
    this.failed.push(code);
    this.ledger.state = "failed";
  }
}

const payment: ReconciledPayment = {
  id: "pay_por15Payment1",
  entity: "payment",
  amount: 19_900,
  amount_captured: 19_900,
  currency: "INR",
  status: "captured",
  order_id: "order_por15Order1",
  captured: true,
};
const order: ReconciledOrder = {
  id: "order_por15Order1",
  entity: "order",
  amount: 19_900,
  amount_paid: 19_900,
  amount_due: 0,
  currency: "INR",
  receipt: "r_por15receipt1",
  status: "paid",
};

class Provider implements RazorpayReconciliationProvider {
  calls = 0;
  constructor(
    private paymentResult: ReconciledPayment = payment,
    private orderResult: ReconciledOrder = order,
    private error?: Error,
  ) {}
  async fetchPayment() {
    this.calls += 1;
    if (this.error) throw this.error;
    return this.paymentResult;
  }
  async fetchOrder() {
    this.calls += 1;
    if (this.error) throw this.error;
    return this.orderResult;
  }
}

function captured(overrides: Partial<SanitizedPaymentEvent> = {}) {
  return {
    supported: true as const,
    event: {
      eventType: "payment.captured" as const,
      paymentId: "pay_por15Payment1",
      orderId: "order_por15Order1",
      status: "captured" as const,
      amount: 19_900,
      currency: "INR",
      captured: true,
      providerCreatedAt: 1_787_440_000,
      ...overrides,
    },
  };
}

describe("POR-15 webhook reconciliation", () => {
  it("durably ingests captured events without provider calls or fulfillment", async () => {
    const repository = new MemoryRepository();
    const provider = new Provider();
    await expect(
      ingestRazorpayWebhook(
        "evt_por15_ingest",
        "0".repeat(64),
        captured(),
        repository,
      ),
    ).resolves.toEqual({
      status: "ACCEPTED",
      eventId: repository.ledger.id,
    });
    expect(repository.ledger.state).toBe("received");
    expect(repository.captured).toBe(0);
    expect(provider.calls).toBe(0);
  });

  it("releases only after webhook and current API evidence both reconcile", async () => {
    const repository = new MemoryRepository();
    const provider = new Provider();
    await expect(
      processRazorpayWebhook("evt_por15_1", "a".repeat(64), captured(), {
        repository,
        provider,
        now: () => new Date("2026-08-23T00:00:00Z"),
      }),
    ).resolves.toEqual({ status: "CAPTURED" });
    expect(repository.captured).toBe(1);
    expect(provider.calls).toBe(2);
    expect(JSON.stringify(repository.recorded)).not.toContain("email");
  });

  it("rejects amount, currency, payment, receipt, and provider-state mismatches", async () => {
    for (const scenario of [
      { parsed: captured({ amount: 100 }), provider: new Provider() },
      { parsed: captured({ currency: "USD" }), provider: new Provider() },
      {
        parsed: captured(),
        provider: new Provider(payment, { ...order, receipt: "wrong" }),
      },
      {
        parsed: captured(),
        provider: new Provider({ ...payment, status: "authorized" }),
      },
    ]) {
      const repository = new MemoryRepository();
      await expect(
        processRazorpayWebhook(
          "evt_por15_mismatch",
          "b".repeat(64),
          scenario.parsed,
          { repository, provider: scenario.provider },
        ),
      ).resolves.toEqual({ status: "REJECTED" });
      expect(repository.captured).toBe(0);
      expect(repository.rejected).toHaveLength(1);
    }
  });

  it("records payment.failed without blocking a later captured event", async () => {
    const repository = new MemoryRepository();
    const provider = new Provider();
    await expect(
      processRazorpayWebhook(
        "evt_por15_failed",
        "c".repeat(64),
        {
          supported: true,
          event: {
            ...captured().event,
            eventType: "payment.failed",
            status: "failed",
            captured: false,
          },
        },
        { repository, provider },
      ),
    ).resolves.toEqual({ status: "RECORDED" });
    expect(repository.informational).toBe(1);
    expect(repository.captured).toBe(0);
    expect(provider.calls).toBe(0);
  });

  it("acknowledges duplicates and unsupported signed events without side effects", async () => {
    const repository = new MemoryRepository();
    repository.ledger.state = "processed";
    const provider = new Provider();
    await expect(
      processRazorpayWebhook("evt_duplicate", "d".repeat(64), captured(), {
        repository,
        provider,
      }),
    ).resolves.toEqual({ status: "DUPLICATE" });
    expect(provider.calls).toBe(0);

    repository.ledger.state = "received";
    await expect(
      processRazorpayWebhook(
        "evt_unsupported",
        "e".repeat(64),
        {
          supported: false,
          eventType: "payment.authorized",
          providerCreatedAt: 1,
        },
        { repository, provider },
      ),
    ).resolves.toEqual({ status: "IGNORED" });
    expect(repository.rejected).toContain("UNSUPPORTED_EVENT");
  });

  it("asks Razorpay to retry when current API reconciliation is unavailable", async () => {
    const repository = new MemoryRepository();
    await expect(
      processRazorpayWebhook("evt_retry", "f".repeat(64), captured(), {
        repository,
        provider: new Provider(payment, order, new Error("provider down")),
      }),
    ).rejects.toBeInstanceOf(RetryableWebhookError);
    expect(repository.failed).toEqual(["PROVIDER_RECONCILIATION_UNAVAILABLE"]);
    expect(repository.captured).toBe(0);
  });

  it("durably rejects a conflicting captured payment without requesting retries", async () => {
    const repository = new MemoryRepository();
    repository.captureError = new CapturedPaymentConflictError("conflict");
    await expect(
      processRazorpayWebhook("evt_conflict", "1".repeat(64), captured(), {
        repository,
        provider: new Provider(),
      }),
    ).resolves.toEqual({ status: "REJECTED" });
    expect(repository.rejected).toEqual(["CAPTURED_PAYMENT_CONFLICT"]);
    expect(repository.failed).toEqual([]);
  });
});
