import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../db/client";
import * as schema from "../db/schema";
import { DrizzleReportRepository } from "../db/report-repository";
import { hashReportAccessToken } from "../db/report-token";
import { roastReports, roasts } from "../db/schema";
import {
  deriveReportViewKey,
  isValidViewKeyFormat,
  verifyReportViewKey,
} from "./view-key";

const HMAC_KEY = "test-hmac-key-material";
const ROAST_ID = "1f0e6d2a-7c9b-4a3e-8d21-55aa10bde999";

function asDatabase(value: unknown): Database {
  return value as unknown as Database;
}

describe("POR-22 report view keys", () => {
  it("derives deterministic 256-bit capabilities per roast", () => {
    const a = deriveReportViewKey(HMAC_KEY, ROAST_ID);
    const b = deriveReportViewKey(HMAC_KEY, ROAST_ID);
    expect(a).toBe(b);
    expect(a).not.toBe(deriveReportViewKey(HMAC_KEY, "other-roast"));
    expect(isValidViewKeyFormat(a)).toBe(true);
    // base64url of 32 bytes = 43 chars ≈ 256 bits of entropy.
    expect(a).toHaveLength(43);
    expect(verifyReportViewKey(a, HMAC_KEY, ROAST_ID)).toBe(true);
    expect(verifyReportViewKey(`${a}x`, HMAC_KEY, ROAST_ID)).toBe(false);
    expect(verifyReportViewKey(a, "wrong-key", ROAST_ID)).toBe(false);
  });
});

describe("POR-22 private report access", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repository: DrizzleReportRepository;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    repository = new DrizzleReportRepository(asDatabase(db));
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

  function viewKeyHash(roastId: string) {
    return hashReportAccessToken(deriveReportViewKey(HMAC_KEY, roastId));
  }

  it("marks active processing roasts completed and binds the capability grant", async () => {
    const roast = await insertRoast("processing");
    expect(await repository.markRoastCompleted(roast.id)).toBe(true);

    await repository.ensureGrantForViewHash(roast.id, viewKeyHash(roast.id));
    const resolved = await repository.resolveReportAccess(
      deriveReportViewKey(HMAC_KEY, roast.id),
    );
    // No report persisted yet -> access still denied.
    expect(resolved).toBeUndefined();
  });

  it("resolves the full deliverable only for completed roasts with a report", async () => {
    const roast = await insertRoast("ready_for_fulfillment");
    await db.insert(roastReports).values({
      roastId: roast.id,
      report: { score: 61, critiques: [], positiveObservation: {} },
      model: "gpt-5.6-terra",
    });
    await repository.markRoastCompleted(roast.id);
    await repository.ensureGrantForViewHash(roast.id, viewKeyHash(roast.id));

    const access = await repository.resolveReportAccess(
      deriveReportViewKey(HMAC_KEY, roast.id),
    );
    expect(access?.hostname).toBe("example.com");
    expect((access?.report as { score: number }).score).toBe(61);

    // Unknown or tampered keys resolve to nothing.
    expect(
      await repository.resolveReportAccess(
        deriveReportViewKey(HMAC_KEY, "nope"),
      ),
    ).toBeUndefined();
  });

  it("revokes stale grants on rotation and denies revoked keys", async () => {
    const roast = await insertRoast("ready_for_fulfillment");
    await repository.markRoastCompleted(roast.id);
    await db.insert(roastReports).values({
      roastId: roast.id,
      report: { score: 40 },
      model: "gpt-5.6-terra",
    });
    const rotatedHash = hashReportAccessToken("rotated-key-value-000");
    await repository.ensureGrantForViewHash(roast.id, rotatedHash);
    await repository.ensureGrantForViewHash(roast.id, rotatedHash); // idempotent

    let grants = await db.query.reportAccessGrants.findMany();
    expect(grants).toHaveLength(1);

    await repository.ensureGrantForViewHash(roast.id, viewKeyHash(roast.id)); // different hash -> rotate
    grants = await db.query.reportAccessGrants.findMany();
    expect(grants.filter(({ revokedAt }) => revokedAt === null)).toHaveLength(
      1,
    );
    expect(grants.filter(({ revokedAt }) => revokedAt !== null)).toHaveLength(
      1,
    );

    // Old capability is dead; only the new one resolves.
    expect(
      await repository.resolveReportAccess("rotated-key-value-000"),
    ).toBeUndefined();
    expect(
      await repository.resolveReportAccess(
        deriveReportViewKey(HMAC_KEY, roast.id),
      ),
    ).toBeDefined();
  });
});
