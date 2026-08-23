import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../db/client";
import { roastReports, roasts } from "../db/schema";

export const auditStatusSchema = z.object({
  state: z.enum(["processing", "completed", "failed", "unknown"]),
});

export type AuditStatus = z.infer<typeof auditStatusSchema>;

const PROCESSING_STATES = [
  "awaiting_payment",
  "ready_for_fulfillment",
  "queued",
  "processing",
] as const;

const FAILED_STATES = [
  "terminal_failure",
  "refund_pending",
  "refunded",
] as const;

/**
 * POR-21: coarse, non-disclosing progress status. Exposes no email, payment
 * metadata, provider errors or report tokens — the report itself stays behind
 * its capability URL. An unknown id is indistinguishable from a deleted one.
 */
export async function resolveAuditStatus(
  db: Database,
  roastId: string,
): Promise<AuditStatus> {
  const roast = await db.query.roasts.findFirst({
    where: eq(roasts.id, roastId),
    columns: { state: true },
  });
  if (!roast || roast.state === "deleted") return { state: "unknown" };
  if ((PROCESSING_STATES as readonly string[]).includes(roast.state))
    return { state: "processing" };
  if ((FAILED_STATES as readonly string[]).includes(roast.state))
    return { state: "failed" };

  // completed: only claim completion when the deliverable truly exists.
  if (roast.state === "completed") {
    const report = await db.query.roastReports.findFirst({
      where: eq(roastReports.roastId, roastId),
      columns: { id: true },
    });
    return report ? { state: "completed" } : { state: "processing" };
  }
  return { state: "unknown" };
}
