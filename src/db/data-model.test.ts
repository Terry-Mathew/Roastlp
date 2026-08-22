import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeCustomerEmail } from "./customer-data";
import { findActiveReportAccess } from "./report-access-query";
import {
  createReportAccessToken,
  hashReportAccessToken,
  verifyReportAccessToken,
} from "./report-token";
import {
  auditJobs,
  jobAttempts,
  payments,
  productEvents,
  refunds,
  reportAccessGrants,
  roasts,
  webhookEvents,
} from "./schema";
import * as schema from "./schema";
import {
  assertStateTransition,
  auditJobTransitions,
  InvalidStateTransitionError,
  paymentTransitions,
  refundTransitions,
  roastTransitions,
  webhookTransitions,
} from "./states";

function createTestDatabase(client: PGlite) {
  return drizzle(client, { schema });
}

describe("POR-6 durable data model", () => {
  let client: PGlite;
  let db: ReturnType<typeof createTestDatabase>;

  beforeEach(async () => {
    client = new PGlite();
    db = createTestDatabase(client);
    await migrate(db, { migrationsFolder: "drizzle" });
  });

  afterEach(async () => {
    await client.close();
  });

  async function insertRoast() {
    const [roast] = await db
      .insert(roasts)
      .values({
        submittedUrl: "https://example.com",
        canonicalUrl: "https://example.com/",
        hostname: "example.com",
        normalizedEmail: "buyer@example.com",
        consentVersion: "checkout-v1",
        privacyNoticeVersion: "privacy-v1",
        consentedAt: new Date("2026-08-23T00:00:00Z"),
      })
      .returning();
    if (!roast) throw new Error("Roast fixture was not created");
    return roast;
  }

  async function captureDatabaseFailure(promise: Promise<unknown>) {
    try {
      await promise;
      throw new Error("Expected the database operation to fail");
    } catch (error) {
      const messages: string[] = [];
      let current: unknown = error;
      while (current instanceof Error) {
        messages.push(current.message);
        current = current.cause;
      }
      return messages.join("\n");
    }
  }

  it("applies the forward-only migration repeatedly to a clean database", async () => {
    await migrate(db, { migrationsFolder: "drizzle" });
    const result = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );

    expect(result.rows.map(({ table_name }) => table_name)).toEqual(
      expect.arrayContaining([
        "audit_jobs",
        "job_attempts",
        "payments",
        "product_events",
        "refunds",
        "report_access_grants",
        "roasts",
        "webhook_events",
      ]),
    );
  });

  it("rejects invalid state regressions in code and in Postgres", async () => {
    expect(() =>
      assertStateTransition(
        "roast",
        roastTransitions,
        "awaiting_payment",
        "completed",
      ),
    ).toThrow(InvalidStateTransitionError);

    const roast = await insertRoast();
    const failure = await captureDatabaseFailure(
      db
        .update(roasts)
        .set({ state: "completed" })
        .where(eq(roasts.id, roast.id)),
    );
    expect(failure).toMatch(/invalid roasts state transition/);

    await db
      .update(roasts)
      .set({ state: "ready_for_fulfillment" })
      .where(eq(roasts.id, roast.id));
    const [updated] = await db
      .select({ state: roasts.state })
      .from(roasts)
      .where(eq(roasts.id, roast.id));
    expect(updated?.state).toBe("ready_for_fulfillment");
  });

  it("defines explicit transition graphs for every mutable lifecycle", () => {
    expect(() =>
      assertStateTransition(
        "payment",
        paymentTransitions,
        "captured",
        "created",
      ),
    ).toThrow(InvalidStateTransitionError);
    expect(() =>
      assertStateTransition("job", auditJobTransitions, "succeeded", "leased"),
    ).toThrow(InvalidStateTransitionError);
    expect(() =>
      assertStateTransition(
        "webhook",
        webhookTransitions,
        "processed",
        "processing",
      ),
    ).toThrow(InvalidStateTransitionError);
    expect(() =>
      assertStateTransition(
        "refund",
        refundTransitions,
        "succeeded",
        "processing",
      ),
    ).toThrow(InvalidStateTransitionError);
  });

  it("enforces Razorpay and webhook idempotency identifiers", async () => {
    const roast = await insertRoast();
    const paymentValues = {
      roastId: roast.id,
      razorpayOrderId: "order_unique_1",
      receipt: "roast_receipt_1",
      amountPaise: 19_900,
    } as const;
    await db.insert(payments).values(paymentValues);
    const duplicatePayment = await captureDatabaseFailure(
      db.insert(payments).values({
        ...paymentValues,
        receipt: "roast_receipt_2",
      }),
    );
    expect(duplicatePayment).toMatch(/payments_razorpay_order_unique/);

    const webhookValues = {
      provider: "razorpay",
      providerEventId: "event_unique_1",
      eventType: "payment.captured",
      payloadDigest: "a".repeat(64),
      verifiedPayload: { paymentId: "pay_1" },
    } as const;
    await db.insert(webhookEvents).values(webhookValues);
    const duplicateWebhook = await captureDatabaseFailure(
      db.insert(webhookEvents).values(webhookValues),
    );
    expect(duplicateWebhook).toMatch(/webhook_provider_event_unique/);

    const wrongAmount = await captureDatabaseFailure(
      db.insert(payments).values({
        roastId: roast.id,
        razorpayOrderId: "order_wrong_amount",
        receipt: "receipt_wrong_amount",
        amountPaise: 100,
      }),
    );
    expect(wrongAmount).toMatch(/payments_phase_1_amount_check/);
  });

  it("stores only a token hash and exposes a customer-safe report projection", async () => {
    const roast = await insertRoast();
    const token = createReportAccessToken();
    const tokenHash = hashReportAccessToken(token);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(verifyReportAccessToken(token, tokenHash)).toBe(true);
    expect(verifyReportAccessToken(`${token}x`, tokenHash)).toBe(false);

    await db
      .insert(reportAccessGrants)
      .values({ roastId: roast.id, tokenHash });
    const result = await findActiveReportAccess(db, tokenHash);

    expect(result).toEqual({
      roastId: roast.id,
      canonicalUrl: "https://example.com/",
      hostname: "example.com",
      grantCreatedAt: expect.any(Date),
    });
    expect(JSON.stringify(result)).not.toContain("buyer@example.com");
    expect(JSON.stringify(result)).not.toContain(token);

    const stored = await client.query<{ token_hash: string }>(
      `select token_hash from report_access_grants where roast_id = $1`,
      [roast.id],
    );
    expect(stored.rows[0]?.token_hash).toBe(tokenHash);
    expect(stored.rows[0]?.token_hash).not.toBe(token);
  });

  it("permits token rotation only after the active grant is revoked", async () => {
    const roast = await insertRoast();
    const firstHash = hashReportAccessToken(createReportAccessToken());
    const secondHash = hashReportAccessToken(createReportAccessToken());
    await db
      .insert(reportAccessGrants)
      .values({ roastId: roast.id, tokenHash: firstHash });

    const simultaneousGrant = await captureDatabaseFailure(
      db
        .insert(reportAccessGrants)
        .values({ roastId: roast.id, tokenHash: secondHash }),
    );
    expect(simultaneousGrant).toMatch(/report_access_one_active_roast_unique/);

    await db
      .update(reportAccessGrants)
      .set({ revokedAt: new Date() })
      .where(eq(reportAccessGrants.tokenHash, firstHash));
    await db
      .insert(reportAccessGrants)
      .values({ roastId: roast.id, tokenHash: secondHash });

    expect(await findActiveReportAccess(db, firstHash)).toBeUndefined();
    expect((await findActiveReportAccess(db, secondHash))?.roastId).toBe(
      roast.id,
    );
  });

  it("normalizes email and enforces normalized storage", async () => {
    expect(normalizeCustomerEmail("  Buyer@Example.COM ")).toBe(
      "buyer@example.com",
    );
    expect(() =>
      normalizeCustomerEmail("buyer@example.com\nBCC:x@y.test"),
    ).toThrow();

    const unnormalizedEmail = await captureDatabaseFailure(
      db.insert(roasts).values({
        submittedUrl: "https://example.com",
        canonicalUrl: "https://example.com/",
        hostname: "example.com",
        normalizedEmail: "Buyer@Example.COM ",
        consentVersion: "checkout-v1",
        privacyNoticeVersion: "privacy-v1",
        consentedAt: new Date(),
      }),
    );
    expect(unnormalizedEmail).toMatch(/roasts_normalized_email_check/);
  });

  it("separates job attempts, refunds, and customer-safe product events", async () => {
    const roast = await insertRoast();
    const [payment] = await db
      .insert(payments)
      .values({
        roastId: roast.id,
        razorpayOrderId: "order_2",
        razorpayPaymentId: "pay_2",
        receipt: "receipt_2",
        amountPaise: 19_900,
      })
      .returning();
    const [job] = await db
      .insert(auditJobs)
      .values({ roastId: roast.id })
      .returning();
    if (!payment || !job) throw new Error("Fixture records were not created");

    await db.insert(jobAttempts).values({
      auditJobId: job.id,
      attemptNumber: 1,
      stage: "capture",
    });
    await db.insert(refunds).values({
      paymentId: payment.id,
      idempotencyKey: "refund:payment-2:terminal-failure",
      amountPaise: 19_900,
      reasonCode: "terminal_technical_failure",
    });
    await db.insert(productEvents).values({
      roastId: roast.id,
      name: "checkout_created",
      correlationId: "019c8e2e-d45d-7b00-a264-0d58918a7531",
    });

    const columns = await client.query<{
      table_name: string;
      column_name: string;
    }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    );
    const columnNames = columns.rows.map(
      ({ table_name, column_name }) => `${table_name}.${column_name}`,
    );
    expect(columnNames).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/screenshot/i),
        "product_events.email",
        "product_events.properties",
      ]),
    );
  });
});
