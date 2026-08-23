import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../db/client";
import { auditJobs, payments, refunds, roasts } from "../db/schema";
import * as schema from "../db/schema";
import {
  RefundConflictError,
  RefundRejectedError,
  type RefundApiClient,
  type RazorpayRefund,
} from "./razorpay-refunds";
import { RefundService } from "./refund-service";

function asDatabase(value: unknown): Database {
  return value as unknown as Database;
}

function refundPayload(
  refundId: string,
  paymentId: string,
  status: "pending" | "processed" | "failed",
): RazorpayRefund {
  return {
    id: refundId,
    entity: "refund",
    payment_id: paymentId,
    amount: 19_900,
    status,
  };
}

describe("POR-18 idempotent refund workflow", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let alerts: Array<Record<string, unknown>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    alerts = [];
  });

  afterEach(async () => client.close());

  async function insertPaidSetup() {
    const [roast] = await db
      .insert(roasts)
      .values({
        submittedUrl: "https://example.com",
        canonicalUrl: "https://example.com/",
        hostname: "example.com",
        normalizedEmail: "buyer@example.com",
        consentVersion: "checkout-v1",
        privacyNoticeVersion: "privacy-v1",
        termsVersion: "terms-v1",
        refundPolicyVersion: "refund-v1",
        consentedAt: new Date("2026-08-23T00:00:00Z"),
        state: "processing",
      })
      .returning();
    if (!roast) throw new Error("roast fixture missing");
    const [payment] = await db
      .insert(payments)
      .values({
        roastId: roast.id,
        state: "captured",
        razorpayOrderId: "order_QR18refunds1",
        razorpayPaymentId: "pay_QR18refunds1",
        receipt: "r_qr18_refund_1",
        amountPaise: 19_900,
        capturedAt: new Date("2026-08-23T00:05:00Z"),
      })
      .returning();
    if (!payment) throw new Error("payment fixture missing");
    return { roast, payment };
  }

  function makeService(api: RefundApiClient): RefundService {
    return new RefundService(asDatabase(db), api, {
      alert: (payload) => alerts.push(payload),
      now: () => new Date("2026-08-23T01:00:00Z"),
    });
  }

  function requestInput(payment: {
    id: string;
    razorpayPaymentId: string | null;
    amountPaise: number;
  }) {
    if (!payment.razorpayPaymentId)
      throw new Error("fixture is missing the provider payment id");
    return {
      paymentRowId: payment.id,
      razorpayPaymentId: payment.razorpayPaymentId,
      amountPaise: payment.amountPaise,
    };
  }

  it("creates exactly one refund per payment across duplicate requests", async () => {
    const { payment } = await insertPaidSetup();
    let createCalls = 0;
    const api: RefundApiClient = {
      create: async (input) => {
        createCalls += 1;
        return refundPayload(
          `rfnd_${createCalls}`,
          input.razorpayPaymentId,
          "pending",
        );
      },
      fetch: async (refundId) =>
        refundPayload(refundId, "pay_QR18refunds1", "pending"),
    };
    const svc = makeService(api);

    await svc.requestRefundForPayment(requestInput(payment));
    await svc.requestRefundForPayment(requestInput(payment));

    expect(createCalls).toBe(1);
    const rows = await db.select().from(refunds);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "processing",
      reasonCode: "TERMINAL_AUDIT_FAILURE",
      amountPaise: 19_900,
    });
    expect(rows[0]?.idempotencyKey).toBe(`rfnd-${payment.id}`);
  });

  it("settles ledger, payment and roast when reconciliation sees processed", async () => {
    const { roast, payment } = await insertPaidSetup();
    const api: RefundApiClient = {
      create: async (input) =>
        refundPayload("rfnd_settle1", input.razorpayPaymentId, "pending"),
      fetch: async (refundId) =>
        refundPayload(refundId, "pay_QR18refunds1", "processed"),
    };
    const svc = makeService(api);

    expect(
      (await svc.requestRefundForPayment(requestInput(payment))).status,
    ).toBe("pending_provider");

    const report = await svc.reconcileUnsettled();
    expect(report.settled).toBe(1);

    const [row] = await db.select().from(refunds);
    expect(row?.state).toBe("succeeded");
    const [paymentRow] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, payment.id));
    expect(paymentRow?.state).toBe("refunded");
    const [roastRow] = await db
      .select()
      .from(roasts)
      .where(eq(roasts.id, roast.id));
    expect(roastRow?.state).toBe("refunded");
  });

  it("keeps conflicts retryable without duplicating rows", async () => {
    const { payment } = await insertPaidSetup();
    const conflicting: RefundApiClient = {
      create: async () => {
        throw new RefundConflictError();
      },
      fetch: async () => {
        throw new Error("not used");
      },
    };
    const svc = makeService(conflicting);
    expect(
      (await svc.requestRefundForPayment(requestInput(payment))).status,
    ).toBe("retry_scheduled");
    const rows = await db.select().from(refunds);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("requested");
  });

  it("records definitive rejections as failed and alerts without silent retries", async () => {
    const { payment } = await insertPaidSetup();
    const rejecting = {
      create: (async () => {
        throw new RefundRejectedError(400, "bad request");
      }) as RefundApiClient["create"],
      fetch: (async () => {
        throw new Error("not used");
      }) as RefundApiClient["fetch"],
    };

    const svc = makeService(rejecting);
    expect(
      (await svc.requestRefundForPayment(requestInput(payment))).status,
    ).toBe("failed_terminal");
    const [row] = await db.select().from(refunds);
    expect(row?.state).toBe("failed");
    expect(row?.errorCode).toBe("REFUND_REJECTED_400");
    expect(alerts.length).toBeGreaterThan(0);

    const repeat = await svc.requestRefundForPayment(requestInput(payment));
    expect(repeat.status).toBe("failed_terminal");
    expect(await db.select().from(refunds)).toHaveLength(1);
  });

  it("drives terminal job -> refund_pending -> full refund settlement", async () => {
    const { roast, payment } = await insertPaidSetup();
    await db.insert(auditJobs).values({ roastId: roast.id });
    const [job] = await db.select().from(auditJobs);

    const api: RefundApiClient = {
      create: async (input) =>
        refundPayload("rfnd_jobterm1", input.razorpayPaymentId, "processed"),
      fetch: async () => {
        throw new Error("not used");
      },
    };
    const svc = makeService(api);

    const outcome = await svc.refundTerminalRoast(job!.id);
    expect(outcome.status).toBe("succeeded");

    const [paymentRow] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, payment.id));
    expect(paymentRow?.state).toBe("refunded");
    const [roastRow] = await db
      .select()
      .from(roasts)
      .where(eq(roasts.id, roast.id));
    expect(roastRow?.state).toBe("refunded");
  });

  it("reports nothing_to_refund for jobs without a captured payment", async () => {
    const { roast } = await insertPaidSetup();
    await db.delete(payments).where(eq(payments.roastId, roast.id));
    await db.insert(auditJobs).values({ roastId: roast.id });
    const [job] = await db.select().from(auditJobs);
    // No refund-capable API should be touched.
    const svc = makeService({
      create: async () => {
        throw new Error("must not be called");
      },
      fetch: async () => {
        throw new Error("must not be called");
      },
    });
    expect((await svc.refundTerminalRoast(job!.id)).status).toBe(
      "nothing_to_refund",
    );
  });

  it("reconciles webhook-driven outcomes through the applier entry point", async () => {
    const { payment } = await insertPaidSetup();
    const api: RefundApiClient = {
      create: async (input) =>
        refundPayload("rfnd_webhook1", input.razorpayPaymentId, "pending"),
      fetch: async () => {
        throw new Error("not used");
      },
    };
    const svc = makeService(api);
    await svc.requestRefundForPayment(requestInput(payment));

    expect(await svc.applyProviderRefundEvent("rfnd_webhook1", "failed")).toBe(
      true,
    );
    const [row] = await db.select().from(refunds);
    expect(row?.state).toBe("failed");
    expect(alerts.length).toBeGreaterThan(0);
    expect(
      await svc.applyProviderRefundEvent("rfnd_unknown1", "succeeded"),
    ).toBe(false);
  });
});
