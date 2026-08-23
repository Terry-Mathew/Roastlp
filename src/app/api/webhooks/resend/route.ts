import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ZodError, z } from "zod";

import { createDatabase } from "../../../../db/client";
import { DrizzleEmailRepository } from "../../../../db/email-repository";
import { webhookEvents } from "../../../../db/schema";
import {
  HANDLED_RESEND_EVENTS,
  SvixVerificationError,
  verifySvixSignature,
} from "../../../../lib/resend-webhook";

export const runtime = "nodejs";
export const maxDuration = 10;

const MAX_BODY_BYTES = 65_536;

const eventSchema = z.object({
  type: z.string(),
  data: z.object({ email_id: z.string().min(1) }),
});

function json(status: number, body: object, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(extra)),
    },
  });
}

function emitSecurityEvent(category: string): void {
  // Fixed allowlisted fields only; never headers, body or addresses.
  console.warn(JSON.stringify({ category, outcome: "rejected" }));
}

/**
 * POR-25 Resend webhook receiver. Verifies the Svix signature, records the
 * verified event under its provider-issued svix id before processing
 * (CONTEXT.md: Webhook Event), then applies bounce/complaint feedback to the
 * delivery ledger so failed addresses are marked and never emailed again.
 * This product sends no marketing email at all, so suppression is inherent;
 * this endpoint preserves the evidence.
 */
export function createResendWebhookRoute(
  env: Record<string, string | undefined> = process.env,
) {
  return async function POST(request: Request): Promise<Response> {
    if (!env.databaseUrl || !env.resendWebhookSecret)
      return json(503, { error: "WEBHOOK_UNAVAILABLE" });

    const raw = await request.text();
    if (raw.length === 0) return json(400, { error: "INVALID_WEBHOOK" });
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES)
      return json(413, { error: "REQUEST_TOO_LARGE" });

    try {
      verifySvixSignature(
        {
          id: request.headers.get("svix-id"),
          timestamp: request.headers.get("svix-timestamp"),
          signature: request.headers.get("svix-signature"),
        },
        raw,
        env.resendWebhookSecret,
      );
    } catch (error) {
      if (error instanceof SvixVerificationError) {
        emitSecurityEvent("resend_webhook_signature_rejected");
        return json(400, { error: "INVALID_WEBHOOK" });
      }
      throw error;
    }

    let parsed: z.infer<typeof eventSchema>;
    try {
      parsed = eventSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError)
        // Unrecognized shapes can never become valid; do not invite retries.
        return json(200, { status: "dropped_unrecognized_event" });
      throw error;
    }

    const database = createDatabase(env.databaseUrl);
    try {
      // Record-before-process keyed by the provider-issued event id.
      const [ledger] = await database.db
        .insert(webhookEvents)
        .values({
          provider: "resend",
          providerEventId: request.headers.get("svix-id")!,
          eventType: parsed.type,
          payloadDigest: createSha256(raw),
          verifiedPayload: parsed,
        })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      if (!ledger)
        // Replay of an already-verified delivery.
        return json(200, { status: "duplicate_event" });

      await database.db
        .update(webhookEvents)
        .set({ state: "processed", processedAt: new Date() })
        .where(eq(webhookEvents.id, ledger.id));

      if (
        !HANDLED_RESEND_EVENTS.includes(
          parsed.type as (typeof HANDLED_RESEND_EVENTS)[number],
        )
      )
        return json(200, { status: "ignored_event_type" });

      const status =
        parsed.type === "email.bounced"
          ? ("bounced" as const)
          : ("complained" as const);
      const applied = await new DrizzleEmailRepository(
        database.db,
      ).applyProviderStatus(parsed.data.email_id, status);
      return json(200, { status: applied ? "applied" : "unknown_message" });
    } catch {
      console.error(
        JSON.stringify({ event: "RESEND_WEBHOOK_PROCESSING_FAILED" }),
      );
      return json(503, { error: "WEBHOOK_RETRY" }, { "retry-after": "30" });
    } finally {
      await database.close();
    }
  };
}

function createSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export const POST = createResendWebhookRoute();
