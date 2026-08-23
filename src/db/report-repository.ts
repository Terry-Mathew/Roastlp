import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "./client";
import { reportAccessGrants, roastReports, roasts } from "./schema";
import { hashReportAccessToken } from "./report-token";

export interface PersistedReport {
  report: unknown;
  model: string;
}

export interface ResolvedReportAccess {
  hostname: string;
  report: unknown;
  model: string;
}

export class DrizzleReportRepository {
  constructor(private db: Database) {}

  async findByRoastId(roastId: string): Promise<PersistedReport | undefined> {
    const row = await this.db.query.roastReports.findFirst({
      where: eq(roastReports.roastId, roastId),
      columns: { report: true, model: true },
    });
    return row ?? undefined;
  }

  /** Idempotent: a roast keeps exactly one report; replays are no-ops. */
  async saveReport(
    roastId: string,
    report: unknown,
    model: string,
  ): Promise<boolean> {
    const [inserted] = await this.db
      .insert(roastReports)
      .values({ roastId, report, model })
      .onConflictDoNothing({ target: roastReports.roastId })
      .returning({ id: roastReports.id });
    return Boolean(inserted);
  }

  async canonicalUrlForRoast(roastId: string): Promise<string | undefined> {
    const roast = await this.db.query.roasts.findFirst({
      where: eq(roasts.id, roastId),
      columns: { canonicalUrl: true },
    });
    return roast?.canonicalUrl;
  }

  /**
   * Advances an active roast through the enforced lifecycle
   * (ready_for_fulfillment -> queued -> processing -> completed). Each step
   * is guarded; the DB transition trigger keeps every hop legal.
   */
  async markRoastCompleted(roastId: string): Promise<boolean> {
    await this.db
      .update(roasts)
      .set({ state: "queued", updatedAt: new Date() })
      .where(
        and(eq(roasts.id, roastId), eq(roasts.state, "ready_for_fulfillment")),
      );
    await this.db
      .update(roasts)
      .set({ state: "processing", updatedAt: new Date() })
      .where(and(eq(roasts.id, roastId), eq(roasts.state, "queued")));
    const [updated] = await this.db
      .update(roasts)
      .set({ state: "completed", updatedAt: new Date() })
      .where(
        and(
          eq(roasts.id, roastId),
          inArray(roasts.state, [
            "ready_for_fulfillment",
            "queued",
            "processing",
          ]),
        ),
      )
      .returning({ id: roasts.id });
    return Boolean(updated);
  }

  /**
   * Ensures an active capability grant bound to the derived view-key hash.
   * The partial unique index permits one active grant per roast, so a stale
   * active grant (key rotation / re-issue) is revoked first. Idempotent when
   * the active grant already matches.
   */
  async ensureGrantForViewHash(
    roastId: string,
    viewKeyHash: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const active = await tx.query.reportAccessGrants.findFirst({
        where: and(
          eq(reportAccessGrants.roastId, roastId),
          isNull(reportAccessGrants.revokedAt),
        ),
      });
      if (active && active.tokenHash === viewKeyHash) return;
      if (active) {
        await tx
          .update(reportAccessGrants)
          .set({ revokedAt: new Date() })
          .where(eq(reportAccessGrants.id, active.id));
      }
      await tx
        .insert(reportAccessGrants)
        .values({ roastId, tokenHash: viewKeyHash })
        .onConflictDoNothing();
    });
  }

  /**
   * Resolves a presented view key to a completed roast's report. Any mismatch
   * (unknown key, revoked grant, non-completed roast) returns undefined so the
   * caller can emit one uniform non-disclosing response.
   */
  async resolveReportAccess(
    presentedToken: string,
  ): Promise<ResolvedReportAccess | undefined> {
    const tokenHash = hashReportAccessToken(presentedToken);
    const grant = await this.db.query.reportAccessGrants.findFirst({
      where: and(
        eq(reportAccessGrants.tokenHash, tokenHash),
        isNull(reportAccessGrants.revokedAt),
      ),
    });
    if (!grant) return undefined;

    const roast = await this.db.query.roasts.findFirst({
      where: eq(roasts.id, grant.roastId),
      columns: { state: true, hostname: true },
    });
    if (!roast || roast.state !== "completed") return undefined;

    const report = await this.findByRoastId(grant.roastId);
    if (!report) return undefined;

    return {
      hostname: roast.hostname,
      report: report.report,
      model: report.model,
    };
  }
}
