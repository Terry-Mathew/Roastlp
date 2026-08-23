import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "./client";
import { emailDeliveries, roasts } from "./schema";

export interface EmailDeliveryRecord {
  id: string;
  roastId: string;
  kind: (typeof emailDeliveries.$inferSelect)["kind"];
  state: (typeof emailDeliveries.$inferSelect)["state"];
  idempotencyKeyHash: string;
  providerMessageId: string | null;
}

export interface PendingEmail {
  deliveryId: string;
  roastId: string;
  kind: (typeof emailDeliveries.$inferSelect)["kind"];
  state: (typeof emailDeliveries.$inferSelect)["state"];
  recipient: string;
  hostname: string;
}

/** Deterministic per-roast-and-kind idempotency key for the provider. */
export function buildEmailIdempotencyKey(
  kind: string,
  roastId: string,
): string {
  return `roast:${roastId}:${kind}`;
}

export function hashEmailIdempotencyKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * POR-25 durable delivery ledger. Exactly one row per (roast, kind); the
 * unique idempotency-key hash makes concurrent sends converge on one row.
 */
export class DrizzleEmailRepository {
  constructor(private db: Database) {}

  /** Returns the existing row when the insert loses the dedup race. */
  async ensurePending(input: {
    roastId: string;
    kind: EmailDeliveryRecord["kind"];
    idempotencyKeyHash: string;
  }): Promise<{ record: EmailDeliveryRecord; created: boolean }> {
    const [inserted] = await this.db
      .insert(emailDeliveries)
      .values({
        roastId: input.roastId,
        kind: input.kind,
        idempotencyKeyHash: input.idempotencyKeyHash,
      })
      .onConflictDoNothing({ target: emailDeliveries.idempotencyKeyHash })
      .returning();
    if (inserted) return { record: inserted, created: true };

    const [existing] = await this.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.idempotencyKeyHash, input.idempotencyKeyHash))
      .limit(1);
    if (!existing) throw new Error("Email delivery row missing after conflict");
    return { record: existing, created: false };
  }

  async findById(deliveryId: string): Promise<EmailDeliveryRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, deliveryId))
      .limit(1);
    return row ?? undefined;
  }

  async findByProviderMessageId(
    providerMessageId: string,
  ): Promise<EmailDeliveryRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.providerMessageId, providerMessageId))
      .limit(1);
    return row ?? undefined;
  }

  async markSent(
    deliveryId: string,
    providerMessageId: string,
    now = new Date(),
  ): Promise<void> {
    await this.db
      .update(emailDeliveries)
      .set({
        state: "sent",
        providerMessageId,
        sentAt: now,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(eq(emailDeliveries.id, deliveryId));
  }

  async markFailed(
    deliveryId: string,
    errorCode: string,
    now = new Date(),
  ): Promise<void> {
    await this.db
      .update(emailDeliveries)
      .set({ state: "failed", lastErrorCode: errorCode, updatedAt: now })
      .where(eq(emailDeliveries.id, deliveryId));
  }

  /** Provider bounce/complaint feedback; keeps the terminal outcome visible. */
  async applyProviderStatus(
    providerMessageId: string,
    status: "bounced" | "complained",
    now = new Date(),
  ): Promise<boolean> {
    const updated = await this.db
      .update(emailDeliveries)
      .set({
        state: status,
        lastErrorCode: status.toUpperCase(),
        updatedAt: now,
      })
      .where(eq(emailDeliveries.providerMessageId, providerMessageId))
      .returning({ id: emailDeliveries.id });
    return updated.length > 0;
  }

  /**
   * Recovery sweep inputs: pending and retryable-failed deliveries joined
   * with the roast fields templates need. Recipient addresses stay inside
   * this module's call boundary — callers receive opaque pending records.
   */
  async findPending(limit: number): Promise<PendingEmail[]> {
    const rows = await this.db
      .select({
        deliveryId: emailDeliveries.id,
        roastId: emailDeliveries.roastId,
        kind: emailDeliveries.kind,
        state: emailDeliveries.state,
        recipient: roasts.normalizedEmail,
        hostname: roasts.hostname,
      })
      .from(emailDeliveries)
      .innerJoin(roasts, eq(roasts.id, emailDeliveries.roastId))
      .where(inArray(emailDeliveries.state, ["pending", "failed"]))
      .limit(limit);
    return rows;
  }

  /** Guard so a sweep never emails a roast that is no longer deliverable. */
  async isRoastInState(
    roastId: string,
    states: (typeof roasts.$inferSelect)["state"][],
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: roasts.id })
      .from(roasts)
      .where(and(eq(roasts.id, roastId), inArray(roasts.state, states)))
      .limit(1);
    return Boolean(row);
  }

  /** Roast state plus recipient for one send decision. */
  async deliveryContextFor(
    roastId: string,
  ): Promise<{ state: string; recipient: string } | undefined> {
    const [row] = await this.db
      .select({ state: roasts.state, recipient: roasts.normalizedEmail })
      .from(roasts)
      .where(eq(roasts.id, roastId))
      .limit(1);
    return row ?? undefined;
  }
}
