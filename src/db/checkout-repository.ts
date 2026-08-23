import { and, eq } from "drizzle-orm";
import type { Database } from "./client";
import { checkoutAttempts, payments, roasts } from "./schema";

export interface PendingCheckoutInput {
  id: string;
  roastId: string;
  requestKeyHash: string;
  requestFingerprint: string;
  receipt: string;
  submittedUrl: string;
  canonicalUrl: string;
  hostname: string;
  normalizedEmail: string;
  consentVersion: string;
  privacyNoticeVersion: string;
  termsVersion: string;
  refundPolicyVersion: string;
  consentedAt: Date;
}

export interface CheckoutAttemptView {
  id: string;
  roastId: string;
  state: "order_creating" | "order_created" | "failed";
  requestFingerprint: string;
  receipt: string;
  razorpayOrderId: string | null;
}

export interface CheckoutRepository {
  findByRequestKey(hash: string): Promise<CheckoutAttemptView | undefined>;
  createPending(input: PendingCheckoutInput): Promise<CheckoutAttemptView>;
  completeOrder(attemptId: string, orderId: string): Promise<void>;
}

export interface PaymentVerificationView {
  state:
    | "created"
    | "authorized"
    | "captured"
    | "failed"
    | "partially_refunded"
    | "refunded";
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
}

export interface PaymentVerificationRepository {
  findPaymentByOrder(
    orderId: string,
  ): Promise<PaymentVerificationView | undefined>;
  recordAuthorizedPayment(orderId: string, paymentId: string): Promise<void>;
}

export class DrizzleCheckoutRepository
  implements CheckoutRepository, PaymentVerificationRepository
{
  constructor(private db: Database) {}

  async findByRequestKey(hash: string) {
    return this.db.query.checkoutAttempts.findFirst({
      where: eq(checkoutAttempts.requestKeyHash, hash),
      columns: {
        id: true,
        roastId: true,
        state: true,
        requestFingerprint: true,
        receipt: true,
        razorpayOrderId: true,
      },
    });
  }

  async createPending(input: PendingCheckoutInput) {
    return this.db.transaction(async (tx) => {
      await tx.insert(roasts).values({
        id: input.roastId,
        submittedUrl: input.submittedUrl,
        canonicalUrl: input.canonicalUrl,
        hostname: input.hostname,
        normalizedEmail: input.normalizedEmail,
        consentVersion: input.consentVersion,
        privacyNoticeVersion: input.privacyNoticeVersion,
        termsVersion: input.termsVersion,
        refundPolicyVersion: input.refundPolicyVersion,
        consentedAt: input.consentedAt,
      });
      const [attempt] = await tx
        .insert(checkoutAttempts)
        .values({
          id: input.id,
          roastId: input.roastId,
          requestKeyHash: input.requestKeyHash,
          requestFingerprint: input.requestFingerprint,
          receipt: input.receipt,
        })
        .returning({
          id: checkoutAttempts.id,
          roastId: checkoutAttempts.roastId,
          state: checkoutAttempts.state,
          requestFingerprint: checkoutAttempts.requestFingerprint,
          receipt: checkoutAttempts.receipt,
          razorpayOrderId: checkoutAttempts.razorpayOrderId,
        });
      if (!attempt) throw new Error("Pending checkout was not created");
      return attempt;
    });
  }

  async completeOrder(attemptId: string, orderId: string) {
    await this.db.transaction(async (tx) => {
      const [attempt] = await tx
        .update(checkoutAttempts)
        .set({
          state: "order_created",
          razorpayOrderId: orderId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(checkoutAttempts.id, attemptId),
            eq(checkoutAttempts.state, "order_creating"),
          ),
        )
        .returning({
          roastId: checkoutAttempts.roastId,
          receipt: checkoutAttempts.receipt,
        });
      if (!attempt) {
        const current = await tx.query.checkoutAttempts.findFirst({
          where: eq(checkoutAttempts.id, attemptId),
        });
        if (
          current?.state === "order_created" &&
          current.razorpayOrderId === orderId
        )
          return;
        throw new Error("Checkout attempt could not accept provider order");
      }
      await tx.insert(payments).values({
        roastId: attempt.roastId,
        razorpayOrderId: orderId,
        receipt: attempt.receipt,
        amountPaise: 19_900,
        currency: "INR",
      });
    });
  }

  async findPaymentByOrder(orderId: string) {
    return this.db.query.payments.findFirst({
      where: eq(payments.razorpayOrderId, orderId),
      columns: {
        state: true,
        razorpayOrderId: true,
        razorpayPaymentId: true,
      },
    });
  }

  async recordAuthorizedPayment(orderId: string, paymentId: string) {
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(payments)
        .set({
          state: "authorized",
          razorpayPaymentId: paymentId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(payments.razorpayOrderId, orderId),
            eq(payments.state, "created"),
          ),
        )
        .returning({ id: payments.id });
      if (updated) return;

      const current = await tx.query.payments.findFirst({
        where: eq(payments.razorpayOrderId, orderId),
        columns: { state: true, razorpayPaymentId: true },
      });
      if (
        current?.razorpayPaymentId === paymentId &&
        ["authorized", "captured", "partially_refunded", "refunded"].includes(
          current.state,
        )
      )
        return;
      throw new Error("Payment authorization conflicts with stored payment");
    });
  }
}
