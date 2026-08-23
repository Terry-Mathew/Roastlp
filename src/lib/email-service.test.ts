import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../db/client";
import * as schema from "../db/schema";
import {
  ResendRejectedError,
  ResendUnavailableError,
  type ResendApiClient,
  type ResendSendResult,
} from "./resend-client";
import { EmailSender } from "./email-service";

describe("POR-25 EmailSender", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sent: Parameters<ResendApiClient["send"]>[0][];

  function asDatabase(value: unknown): Database {
    return value as Database;
  }

  function sender(overrides?: Partial<ResendApiClient>) {
    const api: ResendApiClient = {
      async send(input) {
        sent.push(input);
        return { id: `msg-${sent.length}` } satisfies ResendSendResult;
      },
      ...overrides,
    };
    return new EmailSender(asDatabase(db), api, {
      fromEmail: "RoastMyLP <reports@roastmylp.app>",
      appUrl: "https://roastmylp.app/",
      serviceContact: "support@roastmylp.app",
      log: () => {},
    });
  }

  async function seedCompletedRoast() {
    const [roast] = await db
      .insert(schema.roasts)
      .values({
        state: "completed",
        submittedUrl: "https://example.com",
        canonicalUrl: "https://example.com",
        hostname: "example.com",
        normalizedEmail: "payer@example.com",
        consentVersion: "v1",
        privacyNoticeVersion: "v1",
        termsVersion: "v1",
        refundPolicyVersion: "v1",
        consentedAt: new Date(),
      })
      .returning();
    return roast;
  }

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    sent = [];
  });

  afterEach(async () => client.close());

  it("sends a result email with the private capability link and marks it sent", async () => {
    const roast = await seedCompletedRoast();
    const outcome = await sender().sendResultEmail({
      roastId: roast.id,
      viewKey: "view-key-value-never-logged",
    });

    expect(outcome.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("payer@example.com");
    expect(sent[0].html).toContain(
      "https://roastmylp.app/r/view-key-value-never-logged",
    );
    expect(sent[0].text).toContain("support@roastmylp.app");
    expect(sent[0].headers["idempotency-key"]).toContain(roast.id);

    const deliveries = await db.query.emailDeliveries.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].state).toBe("sent");
    expect(deliveries[0].providerMessageId).toBe("msg-1");
  });

  it("records a result_email_sent product event on first successful delivery", async () => {
    const roast = await seedCompletedRoast();
    await sender().sendResultEmail({ roastId: roast.id, viewKey: "k" });
    const events = await db.query.productEvents.findMany();
    expect(events.map((e) => e.name)).toEqual(["result_email_sent"]);
  });

  it("is idempotent across retries: second call never re-sends", async () => {
    const roast = await seedCompletedRoast();
    const s = sender();
    await s.sendProcessingFailureEmail({ roastId: roast.id });
    const second = await s.sendProcessingFailureEmail({ roastId: roast.id });

    expect(second.status).toBe("already_sent");
    expect(sent).toHaveLength(1);
  });

  it("leaves the ledger pending on provider unavailability and recovers later", async () => {
    const roast = await seedCompletedRoast();
    let fail = true;
    const flaky = sender({
      async send(input) {
        if (fail) throw new ResendUnavailableError("HTTP_503");
        sent.push(input);
        return { id: "msg-ok" };
      },
    });

    const first = await flaky.sendRefundCompletedEmail({ roastId: roast.id });
    expect(first.status).toBe("pending_retry");

    fail = false;
    const second = await flaky.sendRefundCompletedEmail({ roastId: roast.id });
    expect(second.status).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("marks provider rejections failed without retry", async () => {
    const roast = await seedCompletedRoast();
    const rejecting = sender({
      async send() {
        throw new ResendRejectedError(422, "RESEND_INVALID_RECIPIENT");
      },
    });

    const outcome = await rejecting.sendResultEmail({
      roastId: roast.id,
      viewKey: "k",
    });
    expect(outcome.status).toBe("failed_terminal");
    const deliveries = await db.query.emailDeliveries.findMany();
    expect(deliveries[0].state).toBe("failed");
    expect(deliveries[0].lastErrorCode).toBe("RESEND_INVALID_RECIPIENT");
  });

  it("skips roasts that are not in a deliverable state", async () => {
    const [roast] = await db
      .insert(schema.roasts)
      .values({
        state: "processing",
        submittedUrl: "https://example.com",
        canonicalUrl: "https://example.com",
        hostname: "example.com",
        normalizedEmail: "payer@example.com",
        consentVersion: "v1",
        privacyNoticeVersion: "v1",
        termsVersion: "v1",
        refundPolicyVersion: "v1",
        consentedAt: new Date(),
      })
      .returning();

    const outcome = await sender().sendResultEmail({
      roastId: roast.id,
      viewKey: "k",
    });
    expect(outcome.status).toBe("skipped_state");
    expect(sent).toHaveLength(0);
  });

  it("never writes recipient addresses or view keys into ledger rows or logs", async () => {
    const roast = await seedCompletedRoast();
    const logs: Record<string, unknown>[] = [];
    const loggingSender = new EmailSender(
      asDatabase(db),
      {
        async send(input) {
          sent.push(input);
          return { id: "msg-x" };
        },
      },
      {
        fromEmail: "RoastMyLP <reports@roastmylp.app>",
        appUrl: "https://roastmylp.app",
        serviceContact: "support@roastmylp.app",
        log: (payload) => logs.push(payload),
      },
    );

    await loggingSender.sendResultEmail({
      roastId: roast.id,
      viewKey: "super-secret-view-key",
    });

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain("payer@example.com");
    expect(serializedLogs).not.toContain("super-secret-view-key");
    const deliveries = await db.query.emailDeliveries.findMany();
    expect(JSON.stringify(deliveries)).not.toContain("payer@example.com");
    expect(JSON.stringify(deliveries)).not.toContain("super-secret-view-key");
  });
});
