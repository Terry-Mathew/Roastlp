# Razorpay Checkout evidence matrix

Use this runbook only in a protected non-production Preview with Razorpay Test
Mode keys. Never paste keys, signatures, full provider payloads, buyer data or
raw network identifiers into screenshots, commits, logs or Linear.

## Preconditions

- Preview uses a dedicated test database and `rzp_test_...` credentials.
- `CHECKOUT_ENABLED=true` is scoped only to the selected Preview.
- Razorpay automatic capture and the subscribed webhook events are recorded
  with redacted dashboard evidence.
- The test target and email are reserved synthetic values; do not use a customer
  page or personal email.
- POR-15 webhook ingestion is deployed before treating capture as authoritative.
- Checkout remains disabled in Production.

## Matrix

| Scenario           | Test action                                                       | Required application evidence                                                                                                             |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout load      | Submit valid synthetic intake                                     | Server creates exactly INR 19900 order; hosted Checkout loads; application server receives no card, bank or UPI credential                |
| Modal dismissal    | Close Checkout before payment                                     | Roast remains recoverable; UI says no payment was completed; retry is available                                                           |
| Card success       | Use a documented domestic Test Mode card and successful test OTP  | Callback signature is verified against the stored order; UI says authorization is verified but does not promise completion before capture |
| Card failure       | Use Razorpay's documented Test Mode card failure path             | No authorization or fulfillment; safe failure copy and retry remain available                                                             |
| Card retry         | Fail once, then retry successfully from the same recoverable flow | One successful payment is associated with the order; repeated callback verification is a no-op; no duplicate fulfillment                  |
| UPI success        | Use `success@razorpay`                                            | Same server-verification and capture boundaries as card success                                                                           |
| UPI failure        | Use `failure@razorpay`                                            | No authorization or fulfillment; retry remains available                                                                                  |
| UPI retry          | Fail with `failure@razorpay`, then retry with `success@razorpay`  | Late success is accepted only for the stored order; capture remains webhook/API authoritative                                             |
| Duplicate callback | Replay the same verified callback in the controlled test harness  | Payment remains authorized once and the Roast does not advance to fulfillment                                                             |
| Capture            | Observe the Test Mode dashboard and signed POR-15 webhook         | Amount, currency, receipt, order and current captured/paid state reconcile before one fulfillment job exists                              |

## UPI cancellation boundary

Razorpay states that UPI cancellation in Test Mode results in success. Do not
record that as a passed cancellation test. The non-payment cancellation UX is
covered by Checkout modal dismissal. A genuine UPI cancellation requires a
separately approved Live Mode drill with explicit transaction controls and
refund/reconciliation evidence; it is not authorized by this runbook.

## Evidence record

For every row record the UTC timestamp, deployed commit, Preview URL hostname,
scenario, redacted provider order/payment suffix, observed application state,
observed Razorpay state and pass/fail result. Record no secrets or payment
credentials. After the matrix, restore `CHECKOUT_ENABLED=false` for the Preview
unless the next approved staging exercise immediately requires it.

## Current result

On 2026-08-23 the protected Preview for commit `47f7bf0` was reachable, but a
synthetic submission returned `Secure checkout is temporarily unavailable. No
payment was taken.` Test Mode checkout was therefore not enabled/configured and
no provider payment scenario above was executed. POR-14 remains In Progress.
