import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  PaymentVerificationRepository,
  PaymentVerificationView,
} from "../db/checkout-repository";
import {
  PaymentVerificationConflictError,
  PaymentVerificationError,
  verifyCheckoutPayment,
} from "./payment-verification";

const secret = "test-secret-never-a-live-credential";
const orderId = "order_por14Safe123";
const paymentId = "pay_por14Safe456";

function signature(order = orderId, payment = paymentId) {
  return createHmac("sha256", secret)
    .update(`${order}|${payment}`)
    .digest("hex");
}

class MemoryRepository implements PaymentVerificationRepository {
  payment: PaymentVerificationView | undefined = {
    state: "created",
    razorpayOrderId: orderId,
    razorpayPaymentId: null,
  };
  writes = 0;

  async findPaymentByOrder(order: string) {
    return order === this.payment?.razorpayOrderId ? this.payment : undefined;
  }

  async recordAuthorizedPayment(order: string, payment: string) {
    if (!this.payment || order !== this.payment.razorpayOrderId)
      throw new Error("unknown order");
    if (
      this.payment.razorpayPaymentId &&
      this.payment.razorpayPaymentId !== payment
    )
      throw new Error("conflicting payment");
    this.writes += 1;
    this.payment = {
      ...this.payment,
      state: "authorized",
      razorpayPaymentId: payment,
    };
  }
}

function response(overrides: Record<string, string> = {}) {
  return {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature(),
    ...overrides,
  };
}

describe("POR-14 checkout payment verification", () => {
  it("verifies against the server-stored order and records authorization", async () => {
    const repository = new MemoryRepository();
    await expect(
      verifyCheckoutPayment(response(), { repository, keySecret: secret }),
    ).resolves.toEqual({ status: "PAYMENT_AUTHORIZED" });
    expect(repository.payment).toMatchObject({
      state: "authorized",
      razorpayPaymentId: paymentId,
    });
    expect(repository.writes).toBe(1);
  });

  it("rejects a forged signature without mutating payment state", async () => {
    const repository = new MemoryRepository();
    await expect(
      verifyCheckoutPayment(response({ razorpay_signature: "0".repeat(64) }), {
        repository,
        keySecret: secret,
      }),
    ).rejects.toBeInstanceOf(PaymentVerificationError);
    expect(repository.payment?.state).toBe("created");
    expect(repository.writes).toBe(0);
  });

  it("does not trust the callback order id when computing the signature", async () => {
    const repository = new MemoryRepository();
    await expect(
      verifyCheckoutPayment(
        response({
          razorpay_order_id: "order_attackerOrder1",
          razorpay_signature: signature("order_attackerOrder1"),
        }),
        { repository, keySecret: secret },
      ),
    ).rejects.toBeInstanceOf(PaymentVerificationError);
    expect(repository.writes).toBe(0);
  });

  it("rejects unknown fields and malformed provider identifiers", async () => {
    const repository = new MemoryRepository();
    await expect(
      verifyCheckoutPayment(
        { ...response(), unexpected: "field" },
        { repository, keySecret: secret },
      ),
    ).rejects.toThrow();
    await expect(
      verifyCheckoutPayment(
        response({ razorpay_payment_id: "not-a-payment" }),
        { repository, keySecret: secret },
      ),
    ).rejects.toThrow();
  });

  it("rejects a payment already recorded as failed", async () => {
    const repository = new MemoryRepository();
    repository.payment = { ...repository.payment!, state: "failed" };
    await expect(
      verifyCheckoutPayment(response(), { repository, keySecret: secret }),
    ).rejects.toBeInstanceOf(PaymentVerificationConflictError);
    expect(repository.writes).toBe(0);
  });
});
