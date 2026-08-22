import { describe, expect, it, vi } from "vitest";
import type {
  CheckoutAttemptView,
  CheckoutRepository,
  PendingCheckoutInput,
} from "../db/checkout-repository";
import {
  CHECKOUT_CONSENT_VERSION,
  PRIVACY_NOTICE_VERSION,
  REFUND_POLICY_VERSION,
  TERMS_VERSION,
} from "./checkout-policy";
import { CheckoutConflictError, createCheckout } from "./checkout-service";
import type { OrderProvider, RazorpayOrder } from "./razorpay-orders";

const HMAC_KEY = "a-secure-test-key-with-at-least-thirty-two-bytes";
const resolver = async () => [{ address: "93.184.216.34", family: 4 as const }];
const request = {
  url: "https://example.com/landing",
  email: " Buyer@Example.COM ",
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
  consentVersion: CHECKOUT_CONSENT_VERSION,
  privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
  termsVersion: TERMS_VERSION,
  refundPolicyVersion: REFUND_POLICY_VERSION,
  acceptsTermsAndPrivacy: true,
  acknowledgesAutomatedReportAndRefundPolicy: true,
} as const;

class MemoryRepository implements CheckoutRepository {
  attempts = new Map<string, CheckoutAttemptView>();
  pending?: PendingCheckoutInput;
  paymentOrderIds: string[] = [];
  async findByRequestKey(hash: string) {
    return [...this.attempts.values()].find(
      (item) =>
        this.pending?.requestKeyHash === hash && item.id === this.pending.id,
    );
  }
  async createPending(input: PendingCheckoutInput) {
    this.pending = input;
    const attempt: CheckoutAttemptView = {
      id: input.id,
      roastId: input.roastId,
      state: "order_creating",
      requestFingerprint: input.requestFingerprint,
      receipt: input.receipt,
      razorpayOrderId: null,
    };
    this.attempts.set(input.id, attempt);
    return attempt;
  }
  async completeOrder(attemptId: string, orderId: string) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error("missing attempt");
    attempt.state = "order_created";
    attempt.razorpayOrderId = orderId;
    if (!this.paymentOrderIds.includes(orderId))
      this.paymentOrderIds.push(orderId);
  }
}

function order(receipt: string): RazorpayOrder {
  return {
    id: "order_secure123",
    entity: "order",
    amount: 19_900,
    amount_paid: 0,
    amount_due: 19_900,
    currency: "INR",
    receipt,
    status: "created",
  };
}

function dependencies(repository = new MemoryRepository()) {
  const ordersByReceipt = new Map<string, RazorpayOrder>();
  const orders: OrderProvider = {
    findByReceipt: vi.fn(async (receipt) => ordersByReceipt.get(receipt)),
    create: vi.fn(async (receipt) => {
      const value = order(receipt);
      ordersByReceipt.set(receipt, value);
      return value;
    }),
  };
  const limiter = { check: vi.fn(async () => undefined) };
  return {
    repository,
    orders,
    limiter,
    hmacKey: HMAC_KEY,
    publicKeyId: "rzp_test_public",
    urlValidation: { resolver },
    now: () => new Date("2026-08-23T00:00:00Z"),
  };
}

describe("POR-13 checkout creation", () => {
  it("persists consented pending work before creating a server-priced order", async () => {
    const deps = dependencies();
    const result = await createCheckout(request, deps);
    expect(deps.limiter.check).toHaveBeenCalledWith(undefined, "example.com");
    expect(deps.repository.pending).toMatchObject({
      normalizedEmail: "buyer@example.com",
      canonicalUrl: "https://example.com/landing",
      termsVersion: TERMS_VERSION,
      refundPolicyVersion: REFUND_POLICY_VERSION,
    });
    expect(deps.orders.create).toHaveBeenCalledOnce();
    expect(result).toEqual({
      orderId: "order_secure123",
      keyId: "rzp_test_public",
      amount: 19_900,
      currency: "INR",
      name: "RoastMyLP",
      description: "One screenshot-based landing page Roast",
    });
  });

  it("reuses the receipt and order for an identical retried request", async () => {
    const deps = dependencies();
    await createCheckout(request, deps);
    await createCheckout(request, deps);
    expect(deps.orders.create).toHaveBeenCalledOnce();
    expect(deps.repository.paymentOrderIds).toEqual(["order_secure123"]);
  });

  it("reconciles by the same receipt after an ambiguous create failure", async () => {
    const deps = dependencies();
    let created: RazorpayOrder | undefined;
    deps.orders.findByReceipt = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async () => created);
    deps.orders.create = vi.fn(async (receipt) => {
      created = order(receipt);
      throw new Error("connection closed after provider commit");
    });
    const result = await createCheckout(request, deps);
    expect(result.orderId).toBe("order_secure123");
    expect(deps.orders.findByReceipt).toHaveBeenCalledTimes(2);
    expect(deps.repository.paymentOrderIds).toEqual(["order_secure123"]);
  });

  it("rejects an idempotency key reused with different customer input", async () => {
    const deps = dependencies();
    await createCheckout(request, deps);
    await expect(
      createCheckout({ ...request, email: "other@example.com" }, deps),
    ).rejects.toBeInstanceOf(CheckoutConflictError);
    expect(deps.orders.create).toHaveBeenCalledOnce();
  });

  it("fails before persistence and provider spend when abuse control is unavailable", async () => {
    const deps = dependencies();
    deps.limiter.check.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(createCheckout(request, deps)).rejects.toThrow(
      "redis unavailable",
    );
    expect(deps.repository.pending).toBeUndefined();
    expect(deps.orders.create).not.toHaveBeenCalled();
  });

  it("rejects browser-controlled price and unknown request fields", async () => {
    const deps = dependencies();
    await expect(
      createCheckout({ ...request, amount: 1 }, deps),
    ).rejects.toThrow();
    expect(deps.repository.pending).toBeUndefined();
  });
});
