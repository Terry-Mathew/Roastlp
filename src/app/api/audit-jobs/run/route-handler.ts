import { z } from "zod";

import { createDatabase, type Database } from "../../../../db/client";
import { JobService, type AuditPipeline } from "../../../../lib/job-service";
import {
  QStashReceiver,
  QStashSignatureError,
} from "../../../../lib/qstash-receiver";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 4_096;

const deliverySchema = z.object({
  jobId: z.string().uuid(),
});

export interface WorkerEnv {
  databaseUrl?: string;
  qstashCurrentSigningKey?: string;
  qstashNextSigningKey?: string;
  [key: string]: string | undefined;
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

export interface WorkerRouteHooks {
  /**
   * Runs once per successful delivery, after the job state machine settled.
   * Failures here must never fail the job itself: transactional side effects
   * (e.g. POR-25 delivery email) keep durable ledger rows that sweeps retry.
   */
  onJobSucceeded?: (db: Database, jobId: string) => Promise<void>;
}

/**
 * QStash destination for audit-job deliveries.
 *
 * The pipeline is injected as a factory over the request-scoped database so
 * the orchestration layer stays testable and stage implementations can be
 * composed in without touching this boundary again.
 */
export function createAuditJobRoute(
  pipelineFactory: ((db: Database) => AuditPipeline) | null,
  env: WorkerEnv = process.env,
  hooks: WorkerRouteHooks = {},
) {
  return async function POST(request: Request): Promise<Response> {
    if (!pipelineFactory)
      // No configured pipeline yet: refuse without leasing or consuming any
      // attempt budget. QStash's own retries plus the reconciler keep the
      // audit recoverable.
      return json(503, { error: "AUDIT_PIPELINE_UNCONFIGURED" });

    if (
      !env.databaseUrl ||
      !env.qstashCurrentSigningKey ||
      !env.qstashNextSigningKey
    )
      return json(503, { error: "AUDIT_WORKER_UNAVAILABLE" });

    const signature = request.headers.get("upstash-signature");
    if (!signature) return json(401, { error: "MISSING_SIGNATURE" });

    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES)
      return json(413, { error: "REQUEST_TOO_LARGE" });

    let targetUrl: URL;
    try {
      targetUrl = new URL(request.url);
    } catch {
      return json(400, { error: "INVALID_DELIVERY" });
    }

    try {
      new QStashReceiver(
        env.qstashCurrentSigningKey,
        env.qstashNextSigningKey,
      ).verify({ body: raw, signature, url: targetUrl.toString() });
    } catch (error) {
      if (error instanceof QStashSignatureError)
        return json(401, { error: "INVALID_SIGNATURE" });
      throw error;
    }

    let parsed: z.infer<typeof deliverySchema>;
    try {
      parsed = deliverySchema.parse(JSON.parse(raw));
    } catch {
      // Malformed deliveries can never succeed; drop them without retry.
      return json(200, { status: "dropped_invalid_delivery" });
    }

    const database = createDatabase(env.databaseUrl);
    try {
      const service = new JobService(database.db);
      const result = await service.processDelivery(
        parsed.jobId,
        pipelineFactory(database.db),
      );
      if (!result.handled)
        // Another worker owns this job; QStash must not retry.
        return json(200, { status: "already_leased" });
      if (result.outcome === "succeeded" && hooks.onJobSucceeded) {
        try {
          await hooks.onJobSucceeded(database.db, parsed.jobId);
        } catch (error) {
          // The audit succeeded; delivery side effects recover via sweeps.
          console.error(
            JSON.stringify({
              event: "JOB_SUCCESS_HOOK_FAILED",
              code: error instanceof Error ? error.name : "UNKNOWN",
            }),
          );
        }
      }
      return json(200, { status: result.outcome });
    } finally {
      await database.close();
    }
  };
}
