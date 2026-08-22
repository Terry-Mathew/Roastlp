"use client";

import { FormEvent, useRef, useState } from "react";
import { ROAST_PRICE_INR } from "@/lib/product";
import {
  CHECKOUT_CONSENT_VERSION,
  PRIVACY_NOTICE_VERSION,
  REFUND_POLICY_VERSION,
  TERMS_VERSION,
} from "@/lib/checkout-policy";

type Errors = { url?: string; email?: string };

function validateUrl(value: string): string | undefined {
  if (!value.trim()) return "Enter the landing page URL you want roasted.";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "Only public http:// and https:// pages can be reviewed.";
  } catch {
    return "Enter a complete URL beginning with http:// or https://.";
  }
}

function validateEmail(value: string): string | undefined {
  if (!value.trim()) return "Enter the email where we should send the report.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    return "Enter a valid email address, such as you@company.com.";
}

export function RoastIntakeForm() {
  const urlRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef<string>("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const form = new FormData(event.currentTarget);
    const nextErrors: Errors = {
      url: validateUrl(String(form.get("url") ?? "")),
      email: validateEmail(String(form.get("email") ?? "")),
    };
    setErrors(nextErrors);
    if (nextErrors.url) return urlRef.current?.focus();
    if (nextErrors.email) return emailRef.current?.focus();
    if (form.get("terms") !== "on" || form.get("automated") !== "on") {
      setNotice("Accept both checkout disclosures before continuing.");
      return;
    }

    idempotencyKey.current ||= crypto.randomUUID();
    setSubmitting(true);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: form.get("url"),
          email: form.get("email"),
          idempotencyKey: idempotencyKey.current,
          consentVersion: CHECKOUT_CONSENT_VERSION,
          privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
          termsVersion: TERMS_VERSION,
          refundPolicyVersion: REFUND_POLICY_VERSION,
          acceptsTermsAndPrivacy: true,
          acknowledgesAutomatedReportAndRefundPolicy: true,
        }),
      });
      if (!response.ok) {
        setNotice(
          response.status === 400
            ? "Check the URL, email, and disclosures, then try again."
            : "Secure checkout is temporarily unavailable. No payment was taken.",
        );
        return;
      }
      setNotice(
        "Your order is ready. The secure Razorpay payment window will be connected in the next release; no payment has been taken.",
      );
    } catch {
      setNotice(
        "Secure checkout is temporarily unavailable. No payment was taken.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      id="service-terms"
      className="border-rule bg-panel relative min-w-0 border-2 p-5 sm:p-7"
      aria-labelledby="form-heading"
    >
      <div className="bg-signal text-ink absolute -top-px -left-px px-3 py-2 font-mono text-[0.65rem] font-bold tracking-[0.14em] uppercase">
        Case intake / ₹{ROAST_PRICE_INR}
      </div>
      <div className="border-rule mt-9 flex items-end justify-between gap-4 border-b pb-5">
        <div>
          <p className="text-muted font-mono text-xs tracking-[0.14em] uppercase">
            One page · one roast
          </p>
          <h2
            id="form-heading"
            className="mt-2 text-2xl font-black tracking-[-0.035em] uppercase sm:text-3xl"
          >
            Submit your page
          </h2>
        </div>
        <p className="text-signal font-mono text-4xl font-black">
          ₹{ROAST_PRICE_INR}
        </p>
      </div>
      <form className="mt-6" noValidate onSubmit={handleSubmit}>
        <div>
          <label htmlFor="landing-url" className="form-label">
            Landing page URL
          </label>
          <input
            ref={urlRef}
            id="landing-url"
            name="url"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://yourpage.com"
            aria-invalid={Boolean(errors.url)}
            aria-describedby={errors.url ? "url-hint url-error" : "url-hint"}
            className="form-input"
            onBlur={(event) =>
              setErrors((current) => ({
                ...current,
                url: validateUrl(event.target.value),
              }))
            }
          />
          <p id="url-hint" className="form-hint">
            Use a publicly accessible HTTP or HTTPS page.
          </p>
          {errors.url ? (
            <p id="url-error" role="alert" className="form-error">
              <span aria-hidden="true">!</span> {errors.url}
            </p>
          ) : null}
        </div>
        <div className="mt-5">
          <label htmlFor="report-email" className="form-label">
            Email for your private report
          </label>
          <input
            ref={emailRef}
            id="report-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@company.com"
            aria-invalid={Boolean(errors.email)}
            aria-describedby={
              errors.email ? "email-hint email-error" : "email-hint"
            }
            className="form-input"
            onBlur={(event) =>
              setErrors((current) => ({
                ...current,
                email: validateEmail(event.target.value),
              }))
            }
          />
          <p id="email-hint" className="form-hint">
            Used only to deliver this purchase and service updates.
          </p>
          {errors.email ? (
            <p id="email-error" role="alert" className="form-error">
              <span aria-hidden="true">!</span> {errors.email}
            </p>
          ) : null}
        </div>
        <p className="text-muted mt-6 text-xs leading-5">
          By continuing, you confirm you&apos;re authorized to submit this
          public page and accept the{" "}
          <a className="text-link" href="#service-terms">
            service terms
          </a>
          . See how we handle your URL, screenshot, and email in{" "}
          <a className="text-link" href="#privacy-heading">
            privacy
          </a>
          . We also use a keyed, short-lived network signal and the submitted
          domain to prevent checkout abuse; we do not store the raw IP in the
          checkout ledger.
        </p>
        <label className="mt-5 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-5">
          <input
            className="mt-1 size-4 shrink-0 accent-[var(--signal)]"
            name="terms"
            type="checkbox"
            required
          />
          <span>
            I agree to the service terms and privacy notice, and confirm
            I&apos;m authorized to submit this public page.
          </span>
        </label>
        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-5">
          <input
            className="mt-1 size-4 shrink-0 accent-[var(--signal)]"
            name="automated"
            type="checkbox"
            required
          />
          <span>
            I understand this is an automated CRO opinion. Technical failures
            are eligible for a refund under the refund policy; disagreement with
            the opinion alone is not.
          </span>
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="cta focus-ring mt-5 min-h-12 w-full px-5 py-3 text-center font-mono text-sm font-black tracking-[0.06em] uppercase"
        >
          {submitting
            ? "Preparing secure checkout…"
            : `Roast my landing page — ₹${ROAST_PRICE_INR}`}
        </button>
        <p className="text-muted mt-3 text-xs leading-5">
          Automated CRO analysis. No account or subscription. Payment is not
          complete until Razorpay confirms it on the server.
        </p>
        <p
          aria-live="polite"
          className="border-signal text-paper mt-4 min-h-10 border-l-2 pl-3 text-sm leading-5"
        >
          {notice}
        </p>
      </form>
    </section>
  );
}
