import { eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";

import { createDatabase, type Database } from "../../../../db/client";
import { DrizzleEmailRepository } from "../../../../db/email-repository";
import { DrizzleJobRepository } from "../../../../db/job-repository";
import { roasts } from "../../../../db/schema";
import { EmailSender } from "../../../../lib/email-service";
import { JobService } from "../../../../lib/job-service";
import {
  QStashClient,
  QStashPublishError,
} from "../../../../lib/qstash-client";
import { createResendClient } from "../../../../lib/resend-client";
import { deriveReportViewKey } from "../../../../lib/view-key";

export const runtime = "nodejs";
export const maxDuration = 60;

const RECONCILE_BATCH = 25;
const EMAIL_SWEEP_BATCH = 25;

/** Re-drives one ledgered delivery through its kind-specific template. */
async function retryPendingEmail(
  sender: EmailSender,
  delivery: {
    roastId: string;
    kind: "result" | "processing_failure" | "refund_completed";
  },
  hmacKey: string,
): Promise<boolean> {
  const outcome =
    delivery.kind === "result"
      ? await sender.sendResultEmail({
          roastId: delivery.roastId,
          viewKey: deriveReportViewKey(hmacKey, delivery.roastId),
        })
      : delivery.kind === "processing_failure"
        ? await sender.sendProcessingFailureEmail({ roastId: delivery.roastId })
        : await sender.sendRefundCompletedEmail({ roastId: delivery.roastId });
  return outcome.status === "sent";
}

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
  resendApiKey?: string;
  resendFromEmail?: string;
  hmacKey?: string;
  appUrl?: string;
  /** Injectable for tests; overrides databaseUrl when present. */
  db?: Database;
}

/**
 * Scheduled recovery sweep. Re-enqueues paid-but-unqueued jobs and re-drives
 * retry-due or stuck-lease jobs by republishing them to the QStash worker.
 * Protected by a shared secret supplied as the `x-reconcile-secret` header
 * (manual/curl), an `Authorization: Bearer` header (Vercel Cron attaches
 * `Bearer $CRON_SECRET` automatically), or a `?secret=` query parameter.
 */
export function createReconcileRoute(envInput?: ReconcilerEnv) {
  return async function POST(request: Request): Promise<Response> {
    // Read process.env lazily at request time: capturing it in a default
    // parameter snapshots the build-time environment, which lacks Vercel
    // "sensitive" variables at runtime.
    if (!envInput) {
      const raw = process.env as unknown as Record<string, string | undefined>;
      envInput = {
        databaseUrl: raw.DATABASE_URL,
        reconcileSecret: raw.RECONCILE_SECRET,
        qstashToken: raw.QSTASH_TOKEN,
        workerUrl: raw.AUDIT_WORKER_URL,
        resendApiKey: raw.RESEND_API_KEY,
        resendFromEmail: raw.RESEND_FROM_EMAIL,
        hmacKey: raw.ABUSE_SIGNAL_HMAC_KEY,
        appUrl: raw.APP_URL ?? raw.NEXT_PUBLIC_APP_URL,
      };
    }
    const env = envInput;
    if ((!env.databaseUrl && !env.db) || !env.reconcileSecret)
      return json(503, { error: "RECONCILER_UNAVAILABLE" });

    const url = new URL(request.url);
    // Accept the shared secret via header (manual/curl), Authorization Bearer
    // (Vercel Cron auto-attaches `Bearer $CRON_SECRET`), or query parameter
    // (`?secret=`, fallback for schedulers that cannot send headers).
    const authorization = request.headers.get("authorization");
    const bearer =
      authorization && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : null;
    const presented =
      request.headers.get("x-reconcile-secret") ??
      bearer ??
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
      let emailsRetried = 0;

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

      // POR-25: retry pending/failed transactional email deliveries. The
      // EmailSender's ledger dedup makes repeated sweeps safe.
      if (
        env.resendApiKey &&
        env.resendFromEmail &&
        env.hmacKey &&
        env.appUrl
      ) {
        const sender = new EmailSender(
          database.db,
          createResendClient(env.resendApiKey),
          {
            fromEmail: env.resendFromEmail,
            appUrl: env.appUrl,
            serviceContact: "support@roastmylp.app",
          },
        );
        const pending = await new DrizzleEmailRepository(
          database.db,
        ).findPending(EMAIL_SWEEP_BATCH);
        for (const delivery of pending) {
          const retried = await retryPendingEmail(
            sender,
            delivery,
            env.hmacKey,
          );
          if (retried) emailsRetried += 1;
        }
      }

      return json(200, {
        scanned: recoverable.length,
        enqueued,
        skipped,
        emailsRetried,
      });
    } finally {
      await database.close();
    }
  };
}
