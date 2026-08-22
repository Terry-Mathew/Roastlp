import { ZodError } from "zod";
import { createDatabase } from "../../../../db/client";
import {
  DrizzleWebhookRepository,
  WebhookCollisionError,
} from "../../../../db/webhook-repository";
import {
  parseRazorpayWebhook,
  payloadDigest,
  razorpayEventIdSchema,
  validWebhookSignature,
} from "../../../../lib/razorpay-webhook";
import { ingestRazorpayWebhook } from "../../../../lib/webhook-service";

export const runtime = "nodejs";
export const maxDuration = 10;

const MAX_BODY_BYTES = 131_072;
const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json",
};

function json(status: number, body: object, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders, ...extra },
  });
}

export function emitInvalidSignatureSecurityEvent() {
  // Fixed allowlisted fields only: never include headers, body, IDs, IP or PII.
  console.warn(
    JSON.stringify({
      category: "razorpay_webhook_signature_rejected",
      outcome: "rejected",
    }),
  );
}

async function readBoundedBody(request: Request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES)
        throw new RangeError("Webhook body is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: Request) {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  )
    return json(415, { error: "UNSUPPORTED_MEDIA_TYPE" });
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES)
    return json(413, { error: "REQUEST_TOO_LARGE" });

  const required = ["DATABASE_URL", "RAZORPAY_WEBHOOK_SECRET"] as const;
  if (required.some((name) => !process.env[name]))
    return json(503, { error: "WEBHOOK_UNAVAILABLE" }, { "retry-after": "30" });

  const signature = request.headers.get("x-razorpay-signature") ?? "";
  const eventIdResult = razorpayEventIdSchema.safeParse(
    request.headers.get("x-razorpay-event-id"),
  );
  if (!eventIdResult.success) return json(400, { error: "INVALID_WEBHOOK" });

  let rawBody: Uint8Array;
  try {
    rawBody = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof RangeError)
      return json(413, { error: "REQUEST_TOO_LARGE" });
    return json(400, { error: "INVALID_WEBHOOK" });
  }
  if (rawBody.byteLength === 0) return json(400, { error: "INVALID_WEBHOOK" });
  if (rawBody.byteLength > MAX_BODY_BYTES)
    return json(413, { error: "REQUEST_TOO_LARGE" });
  const secrets = [
    process.env.RAZORPAY_WEBHOOK_SECRET!,
    process.env.RAZORPAY_WEBHOOK_PREVIOUS_SECRET,
  ].filter((value): value is string => Boolean(value));
  if (!validWebhookSignature(rawBody, signature, secrets)) {
    emitInvalidSignatureSecurityEvent();
    return json(400, { error: "INVALID_WEBHOOK" });
  }

  let parsed;
  try {
    parsed = parseRazorpayWebhook(rawBody);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError)
      return json(400, { error: "INVALID_WEBHOOK" });
    return json(400, { error: "INVALID_WEBHOOK" });
  }

  const database = createDatabase(process.env.DATABASE_URL!);
  try {
    const result = await ingestRazorpayWebhook(
      eventIdResult.data,
      payloadDigest(rawBody),
      parsed,
      new DrizzleWebhookRepository(database.db),
    );
    return json(200, result);
  } catch (error) {
    if (error instanceof WebhookCollisionError)
      return json(409, { error: "WEBHOOK_CONFLICT" });
    return json(503, { error: "WEBHOOK_RETRY" }, { "retry-after": "30" });
  } finally {
    await database.close();
  }
}
