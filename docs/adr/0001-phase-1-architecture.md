# ADR 0001: Phase 1 architecture and provider strategy

- Status: Accepted for Phase 1 implementation
- Date: 2026-08-23
- Linear: POR-7
- Decision owners: Terry Mathew (product), engineering
- Review triggers: model evaluation completes; a provider changes pricing or retention; expected volume exceeds 1,000 audits/month; a Phase 2 product is approved

## Context

RoastMyLP Phase 1 sells one ₹199 automated deliverable. A customer submits one public landing-page URL and an email address, pays through Razorpay, and receives a private capability-linked report containing a score, five evidence-grounded critiques, and one positive observation. A sanitized scorecard may be downloaded or shared separately.

The architecture must make payment fulfillment idempotent, keep screenshots transient, prevent server-side request forgery (SSRF), avoid account infrastructure, recover from provider failures, and make privacy claims technically true. Live payment enablement remains gated by legal, privacy, security, and operational tickets.

## Decision

Use a modular monolith deployed on Vercel, with Neon Postgres as the durable system of record and QStash as the external job-delivery mechanism. Business state always lives in Postgres; no provider callback is authoritative by itself. Third-party providers sit behind narrow internal seams with production and test adapters.

### Runtime and deployment

- Use the current stable Next.js App Router with strict TypeScript and Tailwind CSS.
- Use the active Node.js LTS release and pnpm, pinned in repository metadata during POR-8.
- Deploy separate preview, staging, and production environments on Vercel.
- Keep all model names, provider endpoints, timeouts, prices, policy versions, and retention durations in validated server configuration. No business rule depends on a hard-coded provider version.
- Use Neon Postgres with Drizzle ORM and forward-only, reviewed migrations.

### Deep modules and seams

The external application interface stays small. Route handlers translate HTTP into calls to these modules; they do not contain business workflows.

| Module              | Interface responsibility                                                                                | Internal production adapter              | Test adapter                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| Audit intake        | Validate submission, record consent/policy version, create a pending audit                              | Drizzle/Postgres                         | Local Postgres-compatible test database      |
| Payment fulfillment | Create orders, reconcile signed events, decide the next valid payment transition, initiate one refund   | Razorpay                                 | Deterministic fake Razorpay adapter          |
| Audit orchestration | Acquire a job lease, advance the audit state machine, classify retries and terminal failures            | QStash delivery plus Postgres job ledger | In-process queue adapter plus test clock     |
| Page capture        | Accept a validated canonical URL and return transient image bytes or a classified failure               | ScreenshotOne binary-response adapter    | Fixture image adapter                        |
| Roast analysis      | Accept image bytes and page context and return a schema-valid roast or classified failure               | OpenAI Responses adapter                 | Fixture/model-contract adapter               |
| Report access       | Issue, verify, revoke, and rotate high-entropy capability tokens; return only customer-safe report data | Postgres token-hash implementation       | Same implementation against test database    |
| Delivery            | Send an idempotent completed, failed, or refund-status email                                            | Resend                                   | In-memory mailbox adapter                    |
| Abuse control       | Enforce privacy-preserving checkout and polling limits                                                  | Upstash Redis                            | In-memory rate-limit adapter plus test clock |

Each module owns its invariants and error classification. Provider response shapes do not cross the seam into route handlers, React modules, or the database schema. Tests exercise the same interfaces used by callers.

### Durable state and idempotency

- Postgres stores audits, payment transitions, webhook event IDs, job attempts, refunds, delivery attempts, report-token hashes, consent evidence, and customer-safe product events.
- Razorpay webhook signatures are verified over the untouched raw request body. `x-razorpay-event-id` is unique in the webhook ledger. Event order is not assumed.
- A captured and reconciled order creates at most one logical audit job. QStash may deliver more than once; a Postgres lease and state transition decide whether work may proceed.
- Refund creation uses a durable idempotency key and is reconciled until a terminal provider state.
- The webhook handler records verified input and returns quickly. Screenshot and AI processing never run inline in the payment webhook.

### Data flow

1. The browser submits URL, email, policy version, and affirmative consent over HTTPS.
2. Audit intake normalizes the email, validates the URL, records a pending audit, and asks the payment module to create a server-priced ₹199 INR order.
3. Razorpay Checkout collects payment details directly. Card/bank details never touch RoastMyLP.
4. The server verifies the checkout response for immediate UX; a signed Razorpay webhook is reconciled into the durable payment ledger and queues fulfillment.
5. QStash calls an authenticated worker endpoint. The orchestrator obtains a Postgres lease.
6. Page capture sends only the already validated public URL to ScreenshotOne and receives binary image bytes with cache/storage disabled.
7. Roast analysis sends the transient screenshot and minimal page context to OpenAI, requests strict structured output, and validates the response locally.
8. The screenshot buffer is released. No screenshot bytes or screenshot URL are written to the application database.
9. The validated report is stored. A cryptographically random report token is generated; only its hash is stored.
10. Resend emails the capability link. The private report uses `noindex`, restrictive cache headers, and a referrer policy that prevents token leakage.
11. The customer may generate or download a sanitized scorecard containing only brand, submitted domain, score, and verdict.

### Trust boundaries

- Browser input is untrusted. Server validation owns price, URL policy, email normalization, and consent evidence.
- Submitted pages are hostile content. URL resolution and every redirect must pass the SSRF policy before any direct fetch or provider call. Screenshot text is data, never model instructions.
- Razorpay client success is not proof of payment. Only server signature verification plus order reconciliation can advance fulfillment.
- All webhooks and QStash callbacks are hostile until raw-body/signature verification succeeds.
- Provider output is untrusted. Screenshot content type/size and AI structured output are validated before use.
- Capability tokens are bearer secrets. They must not enter analytics, logs, referrers, screenshots, or error reports.
- Logs and observability are a separate data-disclosure boundary. Redaction occurs before emission, not only in dashboards.

## Provider register

Detailed contract, DPA, subprocessor, geography, and deletion verification belongs to POR-11. Until that review is complete, retention statements below are architecture requirements or documented public behavior, not proof of negotiated contractual terms.

| Provider       | Purpose                                                | Data received                                                                                    | Required failure behavior                                                                                 | Retention/privacy concern                                                                                                                         | Exit strategy                                                                                            |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Vercel         | Host Next.js and route handlers                        | Requests, IP/network metadata, redacted logs, server configuration                               | Roll back deploy; queue work remains recoverable from Postgres                                            | Edge/function logs and regions must match the privacy notice                                                                                      | Deploy the standards-based Next.js app to another Node host                                              |
| Neon           | Durable relational system of record                    | URL, normalized email, payment metadata, report JSON, token hashes, consent and ops records      | Transactions and constraints prevent partial/duplicate transitions; restore drill required                | Region, backups, branch copies, retention and deletion propagation require POR-11 verification                                                    | Standard Postgres dump/restore; Drizzle migrations are portable                                          |
| Upstash QStash | Authenticated delivery and retries for jobs/schedules  | Opaque audit/job identifier and callback metadata; never screenshot/email/report token           | Duplicate deliveries are expected; Postgres lease and state machine make them safe                        | Public pricing lists delivery/log retention by plan; payload minimization is mandatory                                                            | Publish jobs through a replacement adapter; reconcile pending jobs from Postgres                         |
| Upstash Redis  | Rate limiting only                                     | Hashed/derived abuse keys and short TTL counters                                                 | Fail closed for obvious abuse where safe; bounded fallback for status polling                             | Do not store raw email, report token, screenshot, or full IP as a rate-limit key                                                                  | Replace adapter with another Redis/edge limiter                                                          |
| Razorpay       | Orders, hosted checkout, payment verification, refunds | Order reference, price/currency, customer contact required for checkout, payment/refund metadata | Verify signatures server-side; tolerate duplicate/out-of-order webhooks; reconcile refund state           | Financial/legal retention is not controlled solely by RoastMyLP; disclose processor role                                                          | Payment module supports a replacement gateway; existing transactions remain reconcilable by provider IDs |
| ScreenshotOne  | Full-page screenshot rendering                         | Validated public URL and capture options; transient rendered page/image                          | Classify timeout, blocked, blank, oversized, and provider failures; retry only bounded transient failures | Use binary response with cache/storage disabled; provider may use transient internal buffers                                                      | Replace page-capture adapter or operate a controlled browser service later                               |
| OpenAI         | Vision analysis and strict structured output           | Transient screenshot plus minimal URL/page context and system rubric                             | Timeout and retry are bounded; safety refusal is explicit; invalid output gets at most one repair attempt | Endpoint retention and image-input safety handling must be verified in POR-11; never promise absolute zero retention without eligibility evidence | Replace roast-analysis adapter after passing the same evaluation contract                                |
| Resend         | Transactional result/failure/refund email              | Recipient email, private capability link, minimal message content                                | Idempotency prevents duplicate sends; bounce/complaint handling is operationally visible                  | Email content necessarily exists in mail systems; retention and subprocessors require POR-11 review                                               | Replace delivery adapter; use owned sending domain and portable templates                                |
| Sentry         | Error and performance monitoring                       | Redacted error/trace metadata only                                                               | Application continues if unavailable; alerts must not be the sole recovery mechanism                      | SDK must drop email, URL queries, tokens, payment bodies, screenshots, and AI content before transmission                                         | Disable adapter or replace with another OpenTelemetry-compatible sink                                    |

## Reliability and performance

- Target customer-visible completion is about 60 seconds, but correctness and refund safety outrank this marketing target.
- Worker operations use explicit connect/read/overall timeouts. Retry policy is provider-specific and bounded.
- A scheduled reconciler finds captured-but-not-queued, queued-but-stuck, processing-with-expired-lease, completed-but-not-emailed, and refund-pending records.
- Operational recovery never requires replaying a payment or creating a second audit record.
- First launch capacity is deliberately small. POR-28 establishes measured limits before live traffic.

## Cost model

Costs are assumptions dated 2026-08-23 and must be checked in provider dashboards before launch. Use ₹84 per USD for planning only. Taxes, currency movement, plan minimums, email overages, monitoring plans, database compute, Vercel overages, and support/SLA add-ons can increase cost.

### Variable cost per successful domestic ₹199 audit

| Cost               |        Low |   Expected | Worst retry case | Assumption                                                                                                             |
| ------------------ | ---------: | ---------: | ---------------: | ---------------------------------------------------------------------------------------------------------------------- |
| Razorpay           |      ₹4.70 |      ₹4.70 |            ₹4.70 | 2% platform fee plus 18% GST on the fee; actual method/account pricing can vary                                        |
| ScreenshotOne      |      ₹0.00 |      ₹0.76 |            ₹1.51 | Free/included quota at low case; $0.009 marginal successful capture; worst case assumes two billable captures          |
| OpenAI vision      |      ₹0.25 |      ₹1.25 |            ₹7.50 | Planning envelope pending POR-13 image-token measurement; worst case includes expensive input and bounded repair/retry |
| QStash and Redis   |     <₹0.01 |     <₹0.01 |            ₹0.05 | Usage pricing at launch volume; retries count as QStash messages                                                       |
| Resend             |      ₹0.00 |      ₹0.00 |            ₹0.20 | Expected within plan allowance; worst case placeholder for overage/retry                                               |
| **Variable total** | **≈₹4.95** | **≈₹6.72** |      **≈₹13.96** | Excludes fixed monthly plan amortization and taxes not listed above                                                    |

Expected contribution before fixed infrastructure and income/GST obligations is therefore about ₹192.28 per domestic sale. The earlier “COGS <₹5” statement is not a safe all-in promise: it excludes or understates payment fees, fixed screenshot-plan cost, and retry variance.

### Fixed-plan sensitivity

ScreenshotOne Basic is publicly listed at $17/month for 2,000 included screenshots. At the planning exchange rate this is about ₹1,428/month, adding roughly ₹57 at 25 audits, ₹14 at 100 audits, or ₹1.43 at 1,000 audits if treated as a fully allocated fixed cost. The first 100 screenshots/month are publicly listed as free, but production must not assume a free tier supplies an SLA.

QStash usage pricing is publicly listed at $1 per 100,000 messages, while production SLA/security add-ons can create material fixed cost. Launch may use usage-based tiers, but POR-30 must explicitly accept the absence of a paid SLA or fund the relevant production plan.

## Security and privacy defaults

- Default deny for URL schemes, ports, IP ranges, redirect destinations, and unsupported content types.
- Encrypt transport everywhere; keep credentials only in environment-specific secret stores.
- Store a keyed hash of report tokens and compare safely. Tokens carry at least 128 bits of entropy and are revocable.
- Render AI and URL-derived strings as text, never raw HTML.
- Store no screenshot bytes or persistent screenshot URL.
- Collect no marketing consent and load no advertising tracker in Phase 1.
- Keep private reports out of search indexes, shared caches, referrers, and public galleries.
- Live payment keys remain disabled until all `launch-blocker` issues pass.

## Alternatives rejected

### Inline processing in the Razorpay webhook

Rejected because provider latency would delay acknowledgment, encourage webhook retries, and mix payment integrity with unreliable screenshot/AI work.

### Vercel `after()` or fire-and-forget fetch as the only queue

Rejected because it does not provide the durable delivery, explicit retry, dead-letter visibility, and authenticated callback semantics required here. QStash delivers work; Postgres remains authoritative.

### Self-hosted Puppeteer in Phase 1

Rejected because browser cold starts, sandboxing, anti-bot behavior, memory limits, patching, and SSRF containment add operational risk unrelated to product differentiation.

### Supabase instead of Neon

Rejected for Phase 1 because auth, storage, and realtime are not needed. Standard Postgres portability is retained, so this can be revisited if operational evidence warrants it.

### Direct OpenAI calls from route handlers

Rejected because provider-specific request/response/error details would spread through the application and make evaluation, replacement, and deterministic tests harder.

### Public UUID result pages

Rejected because UUID secrecy alone is a weak privacy contract and cannot be rotated independently. Use a separate high-entropy bearer token whose hash is stored.

### Email OTP on every report view

Rejected for Phase 1 because it adds authentication state and delivery dependency to every visit, contradicting the no-account conversion loop. A capability link is the accepted tradeoff and can be revoked.

### Storing screenshots for support or scorecard generation

Rejected because the report contract can be fulfilled from structured output and a generated brand scorecard. Persistent screenshots would increase privacy, breach, deletion, and provider-storage obligations.

### Building Fix Pack, SEO/AEO, security audits, accounts, or monitoring now

Rejected as Phase 2 scope. None is required for the ₹199 purchase-to-report loop, and each adds distinct data, legal, runtime, or authentication obligations.

## Consequences

### Positive

- Payment state and job state remain recoverable and auditable.
- Provider replacements are localized behind real production/test adapter seams.
- Screenshot retention claims can be enforced technically.
- Most tests run without external credentials and assert behavior through module interfaces.
- The modular monolith avoids premature distributed-system ownership while still isolating external failures.

### Negative and accepted tradeoffs

- QStash and Redis add two Upstash products and another vendor relationship.
- Capability links can be forwarded by the buyer; this limitation must be explained.
- A serverless host plus external queue/database creates cold-start and cross-region latency risk.
- Usage-tier infrastructure may lack a contractual SLA at launch.
- Strict URL policy will reject some legitimate non-standard targets; Phase 1 favors safety over coverage.
- Provider-contract and retention facts remain launch blockers until POR-11 verifies them.

## Verification for POR-7

- [x] Next.js, Vercel, Neon, Drizzle, QStash, Redis, Razorpay, ScreenshotOne, OpenAI, Resend, and Sentry are covered.
- [x] Every provider has purpose, data received, failure behavior, retention concern, and exit strategy.
- [x] Model/provider versions are configuration rather than embedded business logic.
- [x] Low, expected, and worst-retry economics are estimated and assumptions are explicit.
- [x] Phase 2 capabilities are explicitly excluded.

## Sources checked

- Razorpay pricing: https://razorpay.com/pricing/
- Razorpay Standard Checkout verification: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- Razorpay webhook validation and idempotency: https://razorpay.com/docs/webhooks/validate-test/
- ScreenshotOne pricing: https://screenshotone.com/pricing/
- ScreenshotOne caching/storage behavior: https://screenshotone.com/docs/caching/
- ScreenshotOne full-page capture: https://screenshotone.com/docs/guides/full-page-screenshots/
- Upstash QStash pricing and plan limits: https://upstash.com/pricing/qstash
- Upstash Redis pricing: https://upstash.com/pricing/redis
- OpenAI API data controls: https://developers.openai.com/api/docs/guides/your-data
- OpenAI API pricing: https://openai.com/api/pricing/
