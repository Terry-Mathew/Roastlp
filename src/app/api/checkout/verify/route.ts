import { ZodError } from "zod";
import { createDatabase } from "../../../../db/client";
import { DrizzleCheckoutRepository } from "../../../../db/checkout-repository";
import {
  PaymentVerificationConflictError,
  PaymentVerificationError,
  verifyCheckoutPayment,
} from "../../../../lib/payment-verification";

export const runtime = "nodejs";
export const maxDuration = 10;

const MAX_BODY_BYTES = 1_024;
const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json",
};

function json(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

export async function POST(request: Request) {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  )
    return json(415, { error: "UNSUPPORTED_MEDIA_TYPE" });
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES)
    return json(413, { error: "REQUEST_TOO_LARGE" });
  if (
    process.env.CHECKOUT_ENABLED !== "true" ||
    !process.env.DATABASE_URL ||
    !process.env.RAZORPAY_KEY_SECRET
  )
    return json(503, { error: "PAYMENT_VERIFICATION_UNAVAILABLE" });

  let raw: unknown;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      return json(413, { error: "REQUEST_TOO_LARGE" });
    raw = JSON.parse(body);
  } catch {
    return json(400, { error: "INVALID_PAYMENT_RESPONSE" });
  }

  const database = createDatabase(process.env.DATABASE_URL);
  try {
    const result = await verifyCheckoutPayment(raw, {
      repository: new DrizzleCheckoutRepository(database.db),
      keySecret: process.env.RAZORPAY_KEY_SECRET,
    });
    return json(200, result);
  } catch (error) {
    if (error instanceof PaymentVerificationConflictError)
      return json(409, { error: "PAYMENT_VERIFICATION_CONFLICT" });
    if (error instanceof PaymentVerificationError || error instanceof ZodError)
      return json(400, { error: "INVALID_PAYMENT_RESPONSE" });
    return json(503, { error: "PAYMENT_VERIFICATION_UNAVAILABLE" });
  } finally {
    await database.close();
  }
}
