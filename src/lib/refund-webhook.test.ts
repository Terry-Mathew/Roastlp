import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../db/client";
import {
  DrizzleWebhookRepository,
  type WebhookRepository,
} from "../db/webhook-repository";
import { payments, refunds, roasts } from "../db/schema";
import * as schema from "../db/schema";
import { parseRazorpayWebhook, payloadDigest } from "./razorpay-webhook";
import {
  ingestRazorpayWebhook,
  processStoredRazorpayWebhook,
  WebhookServiceDependencies,
} from "./webhook-service";
import { RefundService } from "./refund-service";
import type { RefundApiClient, RazorpayRefund } from "./razorpay-refunds";

function asDatabase(value: unknown): Database {
  return value as unknown as Database;
}

function refundEventBody(
  eventType: "refund.processed" | "refund.failed",
  refundId: string,
  paymentId = "pay_QR18wh1",
) {
  const status = eventType === "refund.processed" ? "processed" : "failed";
  return JSON.stringify({
    entity: "event",
    event: eventType,
    created_at: 1756000000,
    payload: {
      refund: {
        entity: {
          id: refundId,
          entity: "refund",
          payment_id: paymentId,
          amount: 19_900,
          status,
        },
      },
    },
  });
}

describe("POR-18 refund webhook reconciliation", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: WebhookRepository;
  let svc: RefundService;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    repository = new DrizzleWebhookRepository(asDatabase(db));

    const api: RefundApiClient = {
      create: async (input) =>
        ({
          id: "rfnd_QR18webhook1",
          entity: "refund",
          payment_id: input.razorpayPaymentId,
          amount: 19_900,
          status: "pending",
        }) as RazorpayRefund,
      fetch: async () => {
        throw new Error("not used");
      },
    };
    svc = new RefundService(asDatabase(db), api);
  });

  afterEach(async () => client.close());

  async function insertCapturedSetup() {
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
        state: "refund_pending",
      })
      .returning();
    if (!roast) throw new Error("roast fixture missing");
    await db.insert(payments).values({
      roastId: roast.id,
      state: "captured",
      razorpayOrderId: "order_QR18wh1",
      razorpayPaymentId: "pay_QR18wh1",
      receipt: "r_qr18_wh_1",
      amountPaise: 19_900,
      capturedAt: new Date("2026-08-23T00:05:00Z"),
    });
    return roast;
  }

  async function runRefundEvent(
    eventType: "refund.processed" | "refund.failed",
  ) {
    const raw = Uint8Array.from(
      Buffer.from(refundEventBody(eventType, "rfnd_QR18webhook1")),
    );
    const parsed = parseRazorpayWebhook(raw);
    if (!parsed.supported) throw new Error("expected supported refund event");
    const deps: WebhookServiceDependencies = {
      repository,
      provider: {} as WebhookServiceDependencies["provider"],
      refunds: svc,
    };
    const ingested = await ingestRazorpayWebhook(
      `evt_${eventType}`,
      payloadDigest(raw),
      parsed,
      repository,
    );
    if (ingested.status !== "ACCEPTED") throw new Error("ingestion failed");
    return processStoredRazorpayWebhook(ingested.eventId, deps);
  }

  it("settles the refund ledger when refund.processed arrives", async () => {
    const roast = await insertCapturedSetup();
    const [payment] = await db.select().from(payments);

    // An open refund exists against this payment.
    await svc.requestRefundForPayment({
      paymentRowId: payment!.id,
      razorpayPaymentId: "pay_QR18wh1",
      amountPaise: 19_900,
    });

    expect((await runRefundEvent("refund.processed")).status).toBe(
      "REFUND_SYNCED",
    );

    const [row] = await db.select().from(refunds);
    expect(row?.state).toBe("succeeded");
    const [paymentRow] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, payment!.id));
    expect(paymentRow?.state).toBe("refunded");
    const [roastRow] = await db
      .select()
      .from(roasts)
      .where(eq(roasts.id, roast.id));
    expect(roastRow?.state).toBe("refunded");

    // Duplicate delivery is a no-op.
    const dupRaw = Uint8Array.from(
      Buffer.from(refundEventBody("refund.processed", "rfnd_QR18webhook1")),
    );
    const ingested = await ingestRazorpayWebhook(
      "evt_refund.processed",
      payloadDigest(dupRaw),
      parseRazorpayWebhook(dupRaw),
      repository,
    );
    expect(ingested.status).toBe("DUPLICATE");
  });

  it("marks failed provider refunds and keeps them visible for operations", async () => {
    await insertCapturedSetup();
    const [payment] = await db.select().from(payments);
    await svc.requestRefundForPayment({
      paymentRowId: payment!.id,
      razorpayPaymentId: "pay_QR18wh1",
      amountPaise: 19_900,
    });

    expect((await runRefundEvent("refund.failed")).status).toBe(
      "REFUND_SYNCED",
    );
    const [row] = await db.select().from(refunds);
    expect(row?.state).toBe("failed");
    expect(row?.errorCode).toBe("PROVIDER_REFUND_FAILED");
  });
});
