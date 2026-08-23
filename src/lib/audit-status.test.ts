import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../db/schema";
import type { Database } from "../db/client";
import { roastReports, roasts } from "../db/schema";
import { resolveAuditStatus } from "./audit-status";

function asDatabase(value: unknown): Database {
  return value as unknown as Database;
}

const UNKNOWN_ID = "00000000-0000-4000-8000-00000000dead";

describe("POR-21 coarse audit status", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
  });

  afterEach(async () => client.close());

  async function insertRoast(state: (typeof roasts.$inferSelect)["state"]) {
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
        state,
      })
      .returning();
    if (!roast) throw new Error("fixture missing");
    return roast;
  }

  it.each([
    ["awaiting_payment", "processing"],
    ["ready_for_fulfillment", "processing"],
    ["queued", "processing"],
    ["processing", "processing"],
    ["terminal_failure", "failed"],
    ["refund_pending", "failed"],
    ["refunded", "failed"],
  ] as const)("maps %s to %s without disclosure", async (state, expected) => {
    const roast = await insertRoast(state);
    expect(await resolveAuditStatus(asDatabase(db), roast.id)).toEqual({
      state: expected,
    });
  });

  it("maps deleted roasts to unknown without disclosure", async () => {
    const roast = await insertRoast("processing");
    // Legal lifecycle path to deletion runs through terminal_failure.
    await db
      .update(roasts)
      .set({ state: "terminal_failure" })
      .where(eq(roasts.id, roast.id));
    await db
      .update(roasts)
      .set({ state: "deleted", deletedAt: new Date() })
      .where(eq(roasts.id, roast.id));
    expect(await resolveAuditStatus(asDatabase(db), roast.id)).toEqual({
      state: "unknown",
    });
  });

  it("claims completed only when the report deliverable exists", async () => {
    const roast = await insertRoast("completed");
    expect(await resolveAuditStatus(asDatabase(db), roast.id)).toEqual({
      state: "processing",
    });

    await db.insert(roastReports).values({
      roastId: roast.id,
      report: { score: 70 },
      model: "gpt-5.6-terra",
    });
    expect(await resolveAuditStatus(asDatabase(db), roast.id)).toEqual({
      state: "completed",
    });
  });

  it("returns unknown for missing roasts", async () => {
    expect(await resolveAuditStatus(asDatabase(db), UNKNOWN_ID)).toEqual({
      state: "unknown",
    });
  });
});
