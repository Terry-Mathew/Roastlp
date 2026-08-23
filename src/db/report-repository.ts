import { eq } from "drizzle-orm";

import type { Database } from "./client";
import { roastReports, roasts } from "./schema";

export interface PersistedReport {
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
}
