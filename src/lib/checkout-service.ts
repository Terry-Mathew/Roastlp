import { randomUUID } from "node:crypto";
import type { CheckoutRepository } from "../db/checkout-repository";
import { normalizeCustomerEmail } from "../db/customer-data";
import { validateOutboundUrl, type UrlValidationOptions } from "./url-security";
import {
  checkoutRequestSchema,
  type CheckoutRequest,
  type CheckoutResponse,
} from "./checkout-contract";
import { keyedDigest, requestFingerprint } from "./checkout-crypto";
import { ROAST_AMOUNT_PAISE, ROAST_CURRENCY } from "./checkout-policy";
import type { CheckoutLimiter } from "./checkout-abuse";
import type { OrderProvider, RazorpayOrder } from "./razorpay-orders";

export class CheckoutConflictError extends Error {}

export interface CheckoutDependencies {
  repository: CheckoutRepository;
  limiter: CheckoutLimiter;
  orders: OrderProvider;
  hmacKey: string;
  publicKeyId: string;
  ip?: string;
  urlValidation?: UrlValidationOptions;
  now?: () => Date;
}

function publicResponse(keyId: string, order: RazorpayOrder): CheckoutResponse {
  return {
    orderId: order.id,
    keyId,
    amount: ROAST_AMOUNT_PAISE,
    currency: ROAST_CURRENCY,
    name: "RoastMyLP",
    description: "One screenshot-based landing page Roast",
  };
}

async function reconcileOrCreateOrder(
  orders: OrderProvider,
  receipt: string,
  roastId: string,
) {
  const existing = await orders.findByReceipt(receipt);
  if (existing) return existing;
  try {
    return await orders.create(receipt, roastId);
  } catch (error) {
    const recovered = await orders.findByReceipt(receipt);
    if (recovered) return recovered;
    throw error;
  }
}

export async function createCheckout(raw: unknown, deps: CheckoutDependencies) {
  const input: CheckoutRequest = checkoutRequestSchema.parse(raw);
  const validatedUrl = await validateOutboundUrl(input.url, deps.urlValidation);
  const normalizedEmail = normalizeCustomerEmail(input.email);
  const keyHash = keyedDigest(
    deps.hmacKey,
    "checkout-idempotency-v1",
    input.idempotencyKey,
  );
  const fingerprint = requestFingerprint(deps.hmacKey, [
    validatedUrl.canonicalUrl,
    normalizedEmail,
    input.consentVersion,
    input.privacyNoticeVersion,
    input.termsVersion,
    input.refundPolicyVersion,
  ]);

  await deps.limiter.check(deps.ip, validatedUrl.hostname);

  const existing = await deps.repository.findByRequestKey(keyHash);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint)
      throw new CheckoutConflictError("Checkout key was reused");
    const order = await reconcileOrCreateOrder(
      deps.orders,
      existing.receipt,
      existing.roastId,
    );
    await deps.repository.completeOrder(existing.id, order.id);
    return publicResponse(deps.publicKeyId, order);
  }

  const attemptId = randomUUID();
  const roastId = randomUUID();
  const receipt = `r_${attemptId.replaceAll("-", "")}`;
  let attempt;
  try {
    attempt = await deps.repository.createPending({
      id: attemptId,
      roastId,
      requestKeyHash: keyHash,
      requestFingerprint: fingerprint,
      receipt,
      submittedUrl: input.url,
      canonicalUrl: validatedUrl.canonicalUrl,
      hostname: validatedUrl.hostname,
      normalizedEmail,
      consentVersion: input.consentVersion,
      privacyNoticeVersion: input.privacyNoticeVersion,
      termsVersion: input.termsVersion,
      refundPolicyVersion: input.refundPolicyVersion,
      consentedAt: (deps.now ?? (() => new Date()))(),
    });
  } catch (error) {
    const raced = await deps.repository.findByRequestKey(keyHash);
    if (!raced || raced.requestFingerprint !== fingerprint) throw error;
    attempt = raced;
  }
  const order = await reconcileOrCreateOrder(
    deps.orders,
    attempt.receipt,
    attempt.roastId,
  );
  await deps.repository.completeOrder(attempt.id, order.id);
  return publicResponse(deps.publicKeyId, order);
}
