# ADR 0005: Razorpay Checkout and authorization verification

- Status: Implemented for POR-14
- Date researched: 2026-08-23
- Scope: browser Checkout handoff and server verification of the Checkout success response

## Decision

RoastMyLP loads Razorpay Standard Checkout only from Razorpay's hosted
`checkout.js`, opens it with the server-created order, and sends the three
returned provider fields to a same-origin server route. The browser never sees
the Razorpay key secret and never decides that a payment is genuine.

The verification route accepts only a small, closed JSON object. It looks up
the order in Postgres, computes HMAC-SHA256 over the **server-stored** order ID
and returned payment ID, and compares the 32-byte digests in constant time. A
valid callback moves the payment from `created` to `authorized` and records the
unique payment ID. Repeated verification of the same authorization is safe;
an unknown order, bad signature, failed payment, or different payment ID is
rejected without advancing the Roast.

Authorization does not move the Roast to `ready_for_fulfillment`. Razorpay
documents that an authorized payment is not the same as a captured payment.
POR-15 must independently reconcile amount, currency, receipt, order, payment
and captured state through authenticated webhooks/API evidence before any paid
work begins.

The UI therefore says only that authorization was verified and capture is
being confirmed. Verification uncertainty tells the customer not to pay again,
because repeating payment after an ambiguous callback can cause a duplicate
charge.

## Failure and privacy behavior

- Checkout remains gated by `CHECKOUT_ENABLED=false` by default.
- The verification endpoint is non-cacheable and fails closed when disabled or
  incompletely configured.
- Provider failures and dismissals receive generic customer-safe copy; provider
  error bodies, signatures and credentials are not logged.
- Ordinary landing-page views remain first-party-only. The hosted Checkout
  script is requested only after the customer accepts the disclosures and
  submits the form.
- The Checkout response contains no email or submitted URL, and the application
  does not add either value to Checkout options or provider notes.
- The hosted script load is explicit and limited to the payment page. A strict
  production CSP needs verified Razorpay frame/connect origins in a real Test
  Mode browser run; POR-14 does not guess an undocumented origin list that could
  break bank, UPI or 3DS flows.

## Primary sources checked

- Razorpay Standard Checkout integration steps and mandatory signature
  verification: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- Razorpay current end-to-end Checkout guide, including hosted-script,
  authorization/capture and webhook boundaries:
  https://razorpay.com/docs/developer-tools/integrations/standard-checkout/
- Razorpay Standard Checkout best practices:
  https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/best-practices/
- Razorpay Test UPI details, including the documented Test Mode cancellation
  limitation:
  https://razorpay.com/docs/payments/payments/test-upi-details/?preferred-country=IN
- Next.js 16.3.2 bundled Route Handler, Script and CSP guides under
  `node_modules/next/dist/docs/01-app/`.

## Remaining evidence gates

Before `CHECKOUT_ENABLED=true`, run a Razorpay Test Mode payment in the protected
staging Preview and preserve redacted evidence for Checkout load, dismiss,
failure, successful authorization, automatic-capture configuration, webhook
capture, browser CSP/network behavior and duplicate callback handling. Do not
enable live credentials until POR-15 and all launch blockers are complete.

The protected POR-14 Preview was exercised on 2026-08-23 with reserved
synthetic input. It failed closed with `Secure checkout is temporarily
unavailable. No payment was taken.` because Test Mode checkout was not enabled
and configured in that Preview. This is expected safe behavior, but it does not
satisfy the real provider-flow evidence gate.

Razorpay documents that Test Mode UPI cancellation results in a successful
payment. Therefore the acceptance criterion must not claim a simulated UPI
cancellation as evidence. Test Mode can cover UPI success and failure; modal
dismissal can cover customer cancellation without payment; a genuine UPI
cancellation would require a separately approved controlled Live Mode drill.
See `docs/operations/razorpay-checkout-test-matrix.md`.
