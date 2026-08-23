# ADR 0006: Razorpay webhook capture reconciliation

- Status: Implemented for POR-15
- Date researched: 2026-08-23
- Scope: Razorpay payment webhooks through durable release of one paid Roast

## Decision

RoastMyLP exposes a Node.js Route Handler at `/api/webhooks/razorpay`. It reads
the body once as bounded raw bytes and verifies `X-Razorpay-Signature` with
HMAC-SHA256 before parsing JSON or opening the database. The current webhook
secret and an explicitly configured previous secret are accepted during a
controlled rotation window. The Razorpay API key secret is not a webhook
secret and is not used for this signature.

Every authenticated delivery requires `x-razorpay-event-id`. The ledger stores
that event ID, event type, raw-body SHA-256 digest and only the reconciliation
fields needed for operations. It does not retain the raw webhook, email,
contact, card, bank, VPA, error description or signature. Reuse of one provider
event ID with a different digest or type is a conflict. Exact duplicates are
acknowledged without repeating business effects.

The public handler stops after signature validation and the durable sanitized
ledger write, then returns 2xx. It performs no Razorpay API reads and creates no
fulfillment work inline. This keeps acknowledgment inside Razorpay's five-second
window. POR-17's authenticated worker/sweep claims `received` ledger entries and
runs the reconciliation processor described below; a stored event is the only
input, so the raw provider body and its customer/payment-instrument fields are
not copied into the queue.

`payment.failed` is recorded as informational and does not terminally fail the
canonical Payment. Razorpay documents valid `payment.failed` followed by
`payment.captured` sequences, including late authorisation and UPI retry flows.
An unsupported but correctly signed event is recorded as rejected and
acknowledged so a dashboard subscription mistake cannot trigger 24 hours of
pointless retries.

For `payment.captured` and `order.paid`, the signed snapshot is necessary but
not sufficient. The asynchronous processor fetches the current Payment and
Order from Razorpay and reconciles all of the following against the server
ledger:

- payment ID, order ID and captured state;
- exact ₹19900 amount and INR currency;
- exact captured and paid amounts with zero amount due;
- server-created receipt;
- any payment ID already verified by POR-14.

Only a complete match atomically moves Payment to `captured`, moves the Roast
from `awaiting_payment` to `ready_for_fulfillment`, creates its single pending
Audit Job, and marks the Webhook Event processed. POR-17 owns invoking this
processor, safe publication and leased execution of the resulting pending job.

## Retry and ordering behavior

- No event order is assumed. `created -> captured` and
  `authorized -> captured` are both supported.
- A duplicate captured semantic event such as `order.paid` is harmless after
  `payment.captured`; the payment and single Audit Job remain idempotent.
- Provider/API unavailability marks asynchronous processing failed so POR-17's
  bounded worker/sweep can retry it; Razorpay has already received a 2xx for the
  durable ingestion.
- Authenticated permanent mismatches are durably rejected and acknowledged;
  they never release fulfillment and require operational investigation.
- Missing configuration, invalid signatures, malformed event identities and
  oversized bodies fail closed with no payment mutation.
- An invalid signature emits a fixed-field redacted security event; it never
  includes request bodies, signatures, identifiers, addresses or PII.

## Primary sources checked

- Razorpay webhook validation, raw-body HMAC, event-ID idempotency, secret
  rotation and unordered delivery:
  https://razorpay.com/docs/webhooks/validate-test/
- Razorpay payment webhook snapshots, captured fields and documented
  failed-then-captured sequences:
  https://razorpay.com/docs/webhooks/payments/
- Razorpay retry and 2xx acknowledgement behavior:
  https://razorpay.com/docs/webhooks/best-practices/
- Razorpay five-second response window:
  https://razorpay.com/docs/payments/dashboard/account-settings/webhooks/
- Razorpay current Payment and Order retrieval contracts:
  https://razorpay.com/docs/api/payments/fetch-with-id/
  https://razorpay.com/docs/api/orders/fetch-with-id/
- Next.js 16.3.2 bundled Route Handler guide under
  `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`.

## Remaining evidence and launch gates

Before enabling real payment intake:

1. Configure only `payment.captured`, `payment.failed` and `order.paid` on the
   protected Razorpay Test Mode staging endpoint.
2. Preserve redacted evidence for correct signature, bad signature, duplicate
   event ID, out-of-order failure/capture, API outage retry and secret rotation.
3. Confirm automatic capture in the Razorpay Dashboard and reconcile a real
   Test Mode ₹199 order, payment and receipt.
4. Configure a monitored Razorpay webhook alert address and verify that the
   endpoint remains below provider retry/disable thresholds.
5. Keep `CHECKOUT_ENABLED=false` and live keys absent until the remaining
   launch blockers and controlled go-live drill are complete.
