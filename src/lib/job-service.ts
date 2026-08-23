import { eq } from "drizzle-orm";

import type { Database } from "../db/client";
import {
  DrizzleJobRepository,
  LEASE_SECONDS,
  type LeasedJob,
} from "../db/job-repository";
import { auditJobs, roasts } from "../db/schema";

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export interface AuditPipelineInput {
  roastId: string;
  canonicalUrl: string;
}

export type PipelineOutcome =
  | { classification: "succeeded" }
  | { classification: "retryable_failure"; errorCode: string }
  | { classification: "terminal_failure"; errorCode: string };

export type AuditPipeline = (
  input: AuditPipelineInput,
) => Promise<PipelineOutcome>;

export class JobService {
  private repository: DrizzleJobRepository;

  constructor(private db: Database) {
    this.repository = new DrizzleJobRepository(db);
  }

  /** Creates the single durable job for a captured roast. Idempotent. */
  async ensureJobForRoast(roastId: string, now = new Date()) {
    const existing = await this.repository.findByRoastId(roastId);
    if (existing) return existing;

    const [job] = await this.db
      .insert(auditJobs)
      .values({ roastId, state: "pending", createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: auditJobs.roastId })
      .returning();
    if (job) return job;

    // Concurrent creation lost the race; the winner's row is authoritative.
    const racedJob = await this.repository.findByRoastId(roastId);
    if (!racedJob) throw new Error("Audit job could not be created");
    return racedJob;
  }

  async recordEnqueue(jobId: string, qstashMessageId: string) {
    await this.repository.recordQStashMessage(jobId, qstashMessageId);
  }

  /**
   * Processes one delivery: claim lease → run pipeline → classify → schedule
   * bounded exponential backoff or terminal failure. Returns handled:false when
   * another worker owns the delivery so the caller can no-op with 2xx.
   */
  async processDelivery(
    jobId: string,
    pipeline: AuditPipeline,
    now = new Date(),
  ): Promise<
    | { handled: false }
    | {
        handled: true;
        outcome: "succeeded" | "retry_scheduled" | "failed";
      }
  > {
    const leased = await this.repository.lease(jobId, now);
    if (!leased) return { handled: false };
    return this.runLeased(leased, pipeline, now);
  }

  /** Bounded exponential backoff: 30s, 1m, 2m, 4m… capped at 15m. */
  backoffAt(attemptNumber: number, from: Date): Date {
    const delay = Math.min(
      BASE_BACKOFF_MS * 2 ** (attemptNumber - 1),
      MAX_BACKOFF_MS,
    );
    return new Date(from.getTime() + delay);
  }

  async findRecoverable(limit: number, now = new Date()) {
    return this.repository.findRecoverable(limit, now);
  }

  private async runLeased(
    leased: LeasedJob,
    pipeline: AuditPipeline,
    now: Date,
  ): Promise<{
    handled: true;
    outcome: "succeeded" | "retry_scheduled" | "failed";
  }> {
    const { job, leaseToken } = leased;
    const attemptNumber = (await this.repository.countAttempts(job.id)) + 1;

    const attempt = await this.repository.startAttempt(
      job.id,
      attemptNumber,
      "capture",
      now,
    );

    let outcome: PipelineOutcome;
    try {
      outcome = await pipeline({
        roastId: job.roastId,
        canonicalUrl: await this.canonicalUrlFor(job.roastId),
      });
    } catch {
      // Unexpected crashes are transient by default; never lose paid work.
      outcome = {
        classification: "retryable_failure",
        errorCode: "PIPELINE_CRASH",
      };
    }

    switch (outcome.classification) {
      case "succeeded": {
        await this.repository.finishAttempt(attempt.id, "succeeded", null, now);
        await this.repository.markSucceeded(job.id, now);
        return { handled: true, outcome: "succeeded" };
      }
      case "retryable_failure": {
        if (attemptNumber >= MAX_ATTEMPTS) {
          await this.repository.finishAttempt(
            attempt.id,
            "terminal_failure",
            outcome.errorCode,
            now,
          );
          await this.repository.markTerminal(job.id, outcome.errorCode, now);
          return { handled: true, outcome: "failed" };
        }
        await this.repository.finishAttempt(
          attempt.id,
          "retryable_failure",
          outcome.errorCode,
          now,
        );
        await this.repository.releaseLease(
          job.id,
          leaseToken,
          "retry_scheduled",
          this.backoffAt(attemptNumber, now),
          now,
        );
        return { handled: true, outcome: "retry_scheduled" };
      }
      case "terminal_failure": {
        await this.repository.finishAttempt(
          attempt.id,
          "terminal_failure",
          outcome.errorCode,
          now,
        );
        await this.repository.markTerminal(job.id, outcome.errorCode, now);
        return { handled: true, outcome: "failed" };
      }
    }
  }

  private async canonicalUrlFor(roastId: string): Promise<string> {
    const [roast] = await this.db
      .select({ canonicalUrl: roasts.canonicalUrl })
      .from(roasts)
      .where(eq(roasts.id, roastId))
      .limit(1);
    if (!roast) throw new Error("Roast not found for audit job");
    return roast.canonicalUrl;
  }
}

export { LEASE_SECONDS };
