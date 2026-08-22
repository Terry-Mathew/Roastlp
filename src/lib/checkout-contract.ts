import { z } from "zod";
import {
  CHECKOUT_CONSENT_VERSION,
  PRIVACY_NOTICE_VERSION,
  REFUND_POLICY_VERSION,
  TERMS_VERSION,
} from "./checkout-policy";

export const checkoutRequestSchema = z
  .object({
    url: z.string().min(1).max(2_048),
    email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
    idempotencyKey: z.uuid(),
    consentVersion: z.literal(CHECKOUT_CONSENT_VERSION),
    privacyNoticeVersion: z.literal(PRIVACY_NOTICE_VERSION),
    termsVersion: z.literal(TERMS_VERSION),
    refundPolicyVersion: z.literal(REFUND_POLICY_VERSION),
    acceptsTermsAndPrivacy: z.literal(true),
    acknowledgesAutomatedReportAndRefundPolicy: z.literal(true),
  })
  .strict();

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const checkoutResponseSchema = z.object({
  orderId: z.string().regex(/^order_[A-Za-z0-9]+$/),
  keyId: z.string().min(1),
  amount: z.literal(19_900),
  currency: z.literal("INR"),
  name: z.literal("RoastMyLP"),
  description: z.literal("One screenshot-based landing page Roast"),
});

export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
