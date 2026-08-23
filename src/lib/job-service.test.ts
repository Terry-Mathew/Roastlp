import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DrizzleJobRepository,
  hashToken,
  LEASE_SECONDS,
} from "../db/job-repository";
import { JobService, MAX_ATTEMPTS, type AuditPipeline } from "./job-service";
import { auditJobs, jobAttempts, roasts } from "../db/schema";
import type { Database } from "../db/client";

function createTestDatabase(client: PGlite) {
  return drizzle(client);
}

function asDatabase(value: unknown): Database {
  return value as unknown as Database;
}

describe("POR-17 durable audit orchestration", () => {
  let client: PGlite;
  let db: ReturnType<typeof createTestDatabase>;
  let service: JobService;

  beforeEach(async () => {
    client = new PGlite();
    db = createTestDatabase(client);
    await migrate(db, { migrationsFolder: "drizzle" });
    service = new JobService(asDatabase(db));
  });

  afterEach(async () => {
    await client.close();
  });

  async function insertPaidRoast() {
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
        state: "ready_for_fulfillment",
      })
      .returning();
    if (!roast) throw new Error("Roast fixture was not created");
    return roast;
  }

  async function jobFor(roastId: string) {
    const [job] = await db
      .select()
      .from(auditJobs)
      .where(eq(auditJobs.roastId, roastId))
      .limit(1);
    return job!;
  }

  it("creates exactly one durable job per captured roast, idempotently", async () => {
    const roast = await insertPaidRoast();
    const first = await service.ensureJobForRoast(roast.id);
    const second = await service.ensureJobForRoast(roast.id);
    expect(second.id).toBe(first.id);
    expect(first.state).toBe("pending");
  });

  it("leases atomically so concurrent claims are mutually exclusive", async () => {
    const roast = await insertPaidRoast();
    await service.ensureJobForRoast(roast.id);
    const job = await jobFor(roast.id);
    const repository = new DrizzleJobRepository(asDatabase(db));

    const winner = await repository.lease(job.id);
    expect(winner).not.toBeNull();
    expect((await repository.lease(job.id)) ?? null).toBeNull();

    // Only the hash is stored; the plaintext token is not persisted.
    const [row] = await db
      .select()
      .from(auditJobs)
      .where(eq(auditJobs.id, job.id));
    expect(row?.leaseTokenHash).toBe(hashToken(winner!.leaseToken));
    expect(row?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("reclaims an expired lease left by a crashed worker", async () => {
    const roast = await insertPaidRoast();
    await service.ensureJobForRoast(roast.id);
    const job = await jobFor(roast.id);
    const repository = new DrizzleJobRepository(asDatabase(db));

    const stale = await repository.lease(
      job.id,
      new Date(Date.now() - (LEASE_SECONDS + 10) * 1000),
    );
    expect(stale).not.toBeNull();

    const reclaimed = await repository.lease(job.id);
    expect(reclaimed).not.toBeNull();
  });

  it("runs the pipeline once per delivery and records a successful attempt", async () => {
    const roast = await insertPaidRoast();
    await service.ensureJobForRoast(roast.id);
    const job = await jobFor(roast.id);

    const seenUrls: string[] = [];
    const pipeline: AuditPipeline = async (input) => {
      seenUrls.push(input.canonicalUrl);
      return { classification: "succeeded" };
    };

    const result = await service.processDelivery(job.id, pipeline);
    expect(result).toEqual({ handled: true, outcome: "succeeded" });
    expect(seenUrls).toEqual(["https://example.com/"]);

    const attempts = await db.select().from(jobAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: "succeeded", attemptNumber: 1 });

    const [done] = await db
      .select()
      .from(auditJobs)
      .where(eq(auditJobs.id, job.id));
    expect(done?.state).toBe("succeeded");
    expect(done?.leaseTokenHash).toBeNull();
  });

  it("schedules bounded exponential backoff on retryable failures and terminal-fails after MAX_ATTEMPTS", async () => {
    const roast = await insertPaidRoast();
    await service.ensureJobForRoast(roast.id);
    const jobId = (await jobFor(roast.id)).id;
    const now = new Date("2026-08-23T00:00:00Z");

    const failingPipeline: AuditPipeline = async () => ({
      classification: "retryable_failure",
      errorCode: "PROVIDER_TIMEOUT",
    });

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await service.processDelivery(jobId, failingPipeline, now);
      expect(result).toEqual({ handled: true, outcome: "retry_scheduled" });
      const [state] = await db
        .select()
        .from(auditJobs)
        .where(eq(auditJobs.id, jobId));
      expect(state?.state).toBe("retry_scheduled");
      const expectedDelay = Math.min(30_000 * 2 ** (attempt - 1), 900_000);
      expect(state?.nextAttemptAt?.getTime()).toBe(
        now.getTime() + expectedDelay,
      );
    }

    const finalResult = await service.processDelivery(
      jobId,
      failingPipeline,
      now,
    );
    expect(finalResult).toEqual({ handled: true, outcome: "failed" });
    const [terminal] = await db
      .select()
      .from(auditJobs)
      .where(eq(auditJobs.id, jobId));
    expect(terminal).toMatchObject({
      state: "failed",
      terminalErrorCode: "PROVIDER_TIMEOUT",
    });

    const allAttempts = await db
      .select()
      .from(jobAttempts)
      .where(eq(jobAttempts.auditJobId, jobId));
    expect(allAttempts).toHaveLength(MAX_ATTEMPTS);
    void roast;
  });

  it("treats unexpected pipeline crashes as retryable, never losing paid work", async () => {
    const roast = await insertPaidRoast();
    await service.ensureJobForRoast(roast.id);
    const job = await jobFor(roast.id);

    const crashingPipeline: AuditPipeline = async () => {
      throw new Error("unexpected");
    };
    const result = await service.processDelivery(job.id, crashingPipeline);
    expect(result).toMatchObject({ handled: true, outcome: "retry_scheduled" });
  });

  it("classifies terminal failures immediately without burning retries", async () => {
    const roast = await insertPaidRoast();
    await service.ensureJobForRoast(roast.id);
    const job = await jobFor(roast.id);

    const result = await service.processDelivery(job.id, async () => ({
      classification: "terminal_failure",
      errorCode: "PROHIBITED_TARGET",
    }));
    expect(result).toMatchObject({ handled: true, outcome: "failed" });

    const attempts = await db.select().from(jobAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.errorCode).toBe("PROHIBITED_TARGET");
  });

  it("surfaces paid-but-unqueued and stuck jobs to the reconciler", async () => {
    const unqueuedRoast = await insertPaidRoast();
    await service.ensureJobForRoast(unqueuedRoast.id);

    const queuedRoast = await insertPaidRoast();
    const queuedJob = await service.ensureJobForRoast(queuedRoast.id);
    await service.recordEnqueue(queuedJob.id, "msg_done");

    const recoverable = await service.findRecoverable(25);
    const ids = recoverable.map(({ id }) => id);
    expect(ids).toContain((await jobFor(unqueuedRoast.id)).id);
    expect(ids).not.toContain(queuedJob.id);
  });

  it("computes capped exponential backoff", () => {
    const base = new Date("2026-08-23T00:00:00Z");
    expect(service.backoffAt(1, base).getTime() - base.getTime()).toBe(30_000);
    expect(service.backoffAt(2, base).getTime() - base.getTime()).toBe(60_000);
    expect(service.backoffAt(3, base).getTime() - base.getTime()).toBe(120_000);
    expect(service.backoffAt(9, base).getTime() - base.getTime()).toBe(900_000);
  });
});
