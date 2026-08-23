import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

import type { Database } from "./client";
import {
  auditJobs,
  jobAttempts,
  type AuditJobRecord,
  type JobAttemptRecord,
} from "./schema";

const LEASE_TOKEN_BYTES = 32;
export const LEASE_SECONDS = 60;

const LEASEABLE_STATES = ["pending", "retry_scheduled"] as const;
type LeaseableState = (typeof LEASEABLE_STATES)[number];

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newLeaseToken(): string {
  return randomBytes(LEASE_TOKEN_BYTES).toString("hex");
}

export interface LeasedJob {
  job: AuditJobRecord;
  leaseToken: string;
}

export class DrizzleJobRepository {
  constructor(private db: Database) {}

  async findByRoastId(roastId: string): Promise<AuditJobRecord | undefined> {
    const [job] = await this.db
      .select()
      .from(auditJobs)
      .where(eq(auditJobs.roastId, roastId))
      .limit(1);
    return job;
  }

  async findById(id: string): Promise<AuditJobRecord | undefined> {
    const [job] = await this.db
      .select()
      .from(auditJobs)
      .where(eq(auditJobs.id, id))
      .limit(1);
    return job;
  }

  async recordQStashMessage(jobId: string, qstashMessageId: string) {
    await this.db
      .update(auditJobs)
      .set({ qstashMessageId })
      .where(eq(auditJobs.id, jobId));
  }

  /**
   * Atomically claims a job. Succeeds only from pending/retry_scheduled or an
   * expired lease; the WHERE clause makes concurrent claims mutually exclusive.
   * Only the token hash is stored.
   */
  async lease(jobId: string, now = new Date()): Promise<LeasedJob | null> {
    const leaseToken = newLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000);

    const claimed = await this.db
      .update(auditJobs)
      .set({
        state: "leased",
        leaseTokenHash: hashToken(leaseToken),
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(auditJobs.id, jobId),
          or(
            inArray(auditJobs.state, [...LEASEABLE_STATES]),
            and(
              eq(auditJobs.state, "leased"),
              lt(auditJobs.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .returning();

    const job = claimed[0];
    if (!job) return null;
    return { job, leaseToken };
  }

  /** Releases a lease only if the caller still owns it. */
  async releaseLease(
    jobId: string,
    leaseToken: string,
    nextState: LeaseableState,
    nextAttemptAt: Date | null,
    now = new Date(),
  ): Promise<boolean> {
    const updated = await this.db
      .update(auditJobs)
      .set({
        state: nextState,
        nextAttemptAt,
        leaseTokenHash: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(auditJobs.id, jobId),
          eq(auditJobs.leaseTokenHash, hashToken(leaseToken)),
        ),
      )
      .returning({ id: auditJobs.id });
    return updated.length > 0;
  }

  async markSucceeded(jobId: string, now = new Date()): Promise<void> {
    await this.db
      .update(auditJobs)
      .set({
        state: "succeeded",
        leaseTokenHash: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        terminalErrorCode: null,
        updatedAt: now,
      })
      .where(eq(auditJobs.id, jobId));
  }

  async markTerminal(
    jobId: string,
    errorCode: string,
    now = new Date(),
  ): Promise<void> {
    await this.db
      .update(auditJobs)
      .set({
        state: "failed",
        terminalErrorCode: errorCode,
        leaseTokenHash: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(eq(auditJobs.id, jobId));
  }

  async countAttempts(auditJobId: string): Promise<number> {
    const rows = await this.db
      .select({ attemptNumber: jobAttempts.attemptNumber })
      .from(jobAttempts)
      .where(eq(jobAttempts.auditJobId, auditJobId));
    return rows.length;
  }

  async startAttempt(
    auditJobId: string,
    attemptNumber: number,
    stage: JobAttemptRecord["stage"],
    now = new Date(),
  ): Promise<JobAttemptRecord> {
    const [attempt] = await this.db
      .insert(jobAttempts)
      .values({
        auditJobId,
        attemptNumber,
        stage,
        state: "running",
        startedAt: now,
      })
      .returning();
    if (!attempt) throw new Error("Failed to insert job attempt");
    return attempt;
  }

  async finishAttempt(
    attemptId: string,
    state: "succeeded" | "retryable_failure" | "terminal_failure",
    errorCode: string | null,
    now = new Date(),
  ): Promise<void> {
    await this.db
      .update(jobAttempts)
      .set({ state, errorCode, completedAt: now })
      .where(eq(jobAttempts.id, attemptId));
  }

  /** Paid-but-not-queued, retry-due, and stuck-lease jobs for the reconciler. */
  async findRecoverable(limit: number, now = new Date()) {
    return this.db
      .select()
      .from(auditJobs)
      .where(
        or(
          and(
            eq(auditJobs.state, "pending"),
            isNull(auditJobs.qstashMessageId),
          ),
          and(
            eq(auditJobs.state, "retry_scheduled"),
            lt(auditJobs.nextAttemptAt, now),
          ),
          and(eq(auditJobs.state, "leased"), lt(auditJobs.leaseExpiresAt, now)),
        ),
      )
      .orderBy(auditJobs.createdAt)
      .limit(limit);
  }
}
