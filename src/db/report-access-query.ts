import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema";
import { reportAccessGrants, roasts } from "./schema";

export interface CustomerReportAccessRecord {
  roastId: string;
  canonicalUrl: string;
  hostname: string;
  grantCreatedAt: Date;
}

export async function findActiveReportAccess<
  TQueryResult extends PgQueryResultHKT,
>(
  db: PgDatabase<TQueryResult, typeof schema>,
  tokenHash: string,
  extraCondition?: SQL,
): Promise<CustomerReportAccessRecord | undefined> {
  const rows = await db
    .select({
      roastId: roasts.id,
      canonicalUrl: roasts.canonicalUrl,
      hostname: roasts.hostname,
      grantCreatedAt: reportAccessGrants.createdAt,
    })
    .from(reportAccessGrants)
    .innerJoin(roasts, eq(reportAccessGrants.roastId, roasts.id))
    .where(
      and(
        eq(reportAccessGrants.tokenHash, tokenHash),
        isNull(reportAccessGrants.revokedAt),
        extraCondition,
      ),
    )
    .limit(1);

  return rows[0];
}
