import { ZodError } from "zod";
import { createDatabase } from "../../../db/client";
import { DrizzleCheckoutRepository } from "../../../db/checkout-repository";
import {
  CheckoutConflictError,
  createCheckout,
} from "../../../lib/checkout-service";
import {
  CheckoutRateLimitedError,
  createCheckoutLimiter,
  RateLimitUnavailableError,
  trustedVercelIp,
} from "../../../lib/checkout-abuse";
import { RazorpayOrders } from "../../../lib/razorpay-orders";
import { UrlSecurityError } from "../../../lib/url-security";

export const runtime = "nodejs";
export const maxDuration = 10;

const MAX_BODY_BYTES = 4_096;
const headers = {
  "cache-control": "no-store",
  "content-type": "application/json",
};
function json(status: number, body: object, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, ...extra },
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

  const required = [
    "DATABASE_URL",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "ABUSE_SIGNAL_HMAC_KEY",
  ] as const;
  if (
    process.env.CHECKOUT_ENABLED !== "true" ||
    required.some((name) => !process.env[name])
  )
    return json(
      503,
      { error: "CHECKOUT_UNAVAILABLE" },
      { "retry-after": "300" },
    );

  let raw: unknown;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      return json(413, { error: "REQUEST_TOO_LARGE" });
    raw = JSON.parse(body);
  } catch {
    return json(400, { error: "INVALID_REQUEST" });
  }

  const database = createDatabase(process.env.DATABASE_URL!);
  try {
    const result = await createCheckout(raw, {
      repository: new DrizzleCheckoutRepository(database.db),
      limiter: createCheckoutLimiter(
        process.env.UPSTASH_REDIS_REST_URL!,
        process.env.UPSTASH_REDIS_REST_TOKEN!,
        process.env.ABUSE_SIGNAL_HMAC_KEY!,
      ),
      orders: new RazorpayOrders(
        process.env.RAZORPAY_KEY_ID!,
        process.env.RAZORPAY_KEY_SECRET!,
      ),
      hmacKey: process.env.ABUSE_SIGNAL_HMAC_KEY!,
      publicKeyId: process.env.RAZORPAY_KEY_ID!,
      ip: trustedVercelIp(request.headers, process.env.VERCEL === "1"),
    });
    return json(201, result);
  } catch (error) {
    if (error instanceof CheckoutRateLimitedError)
      return json(
        429,
        { error: "TOO_MANY_REQUESTS" },
        { "retry-after": String(Math.min(error.retryAfterSeconds, 3600)) },
      );
    if (error instanceof RateLimitUnavailableError)
      return json(
        503,
        { error: "CHECKOUT_UNAVAILABLE" },
        { "retry-after": "30" },
      );
    if (error instanceof CheckoutConflictError)
      return json(409, { error: "CHECKOUT_CONFLICT" });
    if (error instanceof ZodError || error instanceof UrlSecurityError)
      return json(400, { error: "INVALID_REQUEST" });
    return json(502, { error: "ORDER_CREATION_FAILED" });
  } finally {
    await database.close();
  }
}
