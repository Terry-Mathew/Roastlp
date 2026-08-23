import { eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";

import { createDatabase, type Database } from "../../../../db/client";
import { DrizzleJobRepository } from "../../../../db/job-repository";
import { roasts } from "../../../../db/schema";
import { JobService } from "../../../../lib/job-service";
import {
  QStashClient,
  QStashPublishError,
} from "../../../../lib/qstash-client";

export const runtime = "nodejs";
export const maxDuration = 60;

const RECONCILE_BATCH = 25;

function json(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}

export interface ReconcilerEnv {
  databaseUrl?: string;
  reconcileSecret?: string;
  qstashToken?: string;
  workerUrl?: string;
  /** Injectable for tests; overrides databaseUrl when present. */
  db?: Database;
}

/**
 * Scheduled recovery sweep. Re-enqueues paid-but-unqueued jobs and re-drives
 * retry-due or stuck-lease jobs by republishing them to the QStash worker.
 * Protected by a shared secret supplied either as the `x-reconcile-secret`
 * header (manual/curl) or a `?secret=` query parameter (Vercel Cron, which
 * cannot send custom headers).
 */
export function createReconcileRoute(
  env: ReconcilerEnv = process.env as unknown as ReconcilerEnv,
) {
  return async function POST(request: Request): Promise<Response> {
    if ((!env.databaseUrl && !env.db) || !env.reconcileSecret)
      return json(503, { error: "RECONCILER_UNAVAILABLE" });

    const url = new URL(request.url);
    const presented =
      request.headers.get("x-reconcile-secret") ??
      url.searchParams.get("secret") ??
      "";
    const expected = env.reconcileSecret;
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
    )
      return json(401, { error: "UNAUTHORIZED" });

    const database = env.db
      ? { db: env.db, close: async () => {} }
      : createDatabase(env.databaseUrl!);
    try {
      const service = new JobService(database.db);
      const repository = new DrizzleJobRepository(database.db);
      const recoverable = await service.findRecoverable(
        RECONCILE_BATCH,
        new Date(),
      );

      let enqueued = 0;
      let skipped = 0;

      for (const job of recoverable) {
        // Stuck leases are simply re-leased on next delivery; republishing is
        // safe because lease claiming makes duplicate deliveries no-ops.
        if (!env.qstashToken || !env.workerUrl) {
          skipped += 1;
          continue;
        }
        const [roast] = await database.db
          .select({ state: roasts.state })
          .from(roasts)
          .where(eq(roasts.id, job.roastId))
          .limit(1);
        if (!roast || roast.state !== "ready_for_fulfillment") {
          skipped += 1;
          continue;
        }

        try {
          const client = new QStashClient(env.qstashToken);
          const { messageId } = await client.publish({
            destinationUrl: env.workerUrl,
            body: { jobId: job.id },
            retries: 3,
          });
          await repository.recordQStashMessage(job.id, messageId);
          enqueued += 1;
        } catch (error) {
          if (error instanceof QStashPublishError) {
            skipped += 1;
            continue;
          }
          throw error;
        }
      }

      return json(200, {
        scanned: recoverable.length,
        enqueued,
        skipped,
      });
    } finally {
      await database.close();
    }
  };
}
