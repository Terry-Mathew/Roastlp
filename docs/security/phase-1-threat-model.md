# RoastMyLP Phase 1 threat model

- Status: Approved baseline for implementation
- Date researched: 2026-08-23
- Linear: POR-10
- Scope: ₹199 Roast purchase-to-report flow only
- Related decision: `docs/adr/0001-phase-1-architecture.md`
- Review triggers: route/provider/data-flow change; new public endpoint; authentication added; Phase 2 approval; material incident; OWASP baseline update

## Purpose and security objectives

This document models how an attacker, malicious submitted page, forged provider, curious customer, or failing dependency could compromise RoastMyLP Phase 1. It is a design constraint for later tickets, not evidence that controls have already been implemented.

Security objectives, in priority order:

1. Never fulfill, email, or refund from an unverified payment/provider event.
2. Never let a submitted URL reach internal, private, link-local, metadata, or otherwise prohibited network targets.
3. Keep email addresses, payment metadata, screenshots, report capability tokens, and reports out of other customers' reach and out of logs.
4. Treat submitted pages, provider responses, and AI output as untrusted data.
5. Make duplicate, delayed, concurrent, and out-of-order events safe.
6. Bound every operation that can spend money or exhaust capacity.
7. Preserve enough redacted evidence to detect abuse and recover paid audits.

## Method

The model uses a practical STRIDE-style review plus abuse/economic-risk analysis. Risk is recorded as `Critical`, `High`, `Medium`, or `Low` from likelihood and business impact. An owner is the Linear implementation area responsible for the control; Terry remains the accountable product owner until roles are delegated.

Residual risk is what remains after the listed controls work. It must be accepted explicitly at launch if it cannot be removed.

## System and trust boundaries

```text
Untrusted browser
  | URL, email, consent, checkout response, route/query values
  v
Vercel / Next.js public edge and route handlers
  | validated commands
  v
Postgres durable state <---- verified Razorpay webhooks
  | job id                     verified QStash callbacks
  v
Audit orchestrator
  |---- validated URL ----> ScreenshotOne ----> transient image bytes
  |---- image + rubric ---> OpenAI -----------> untrusted structured output
  |---- recipient + link -> Resend -----------> customer mailbox
  `---- redacted signals --> Sentry / operational metrics

Customer browser <---- capability token ---- private report / scorecard
```

Trust changes occur at every arrow. TLS or a provider relationship does not make input trusted; cryptographic authentication and semantic validation are separate requirements.

## Complete external-input inventory

All browser and provider inputs are validated on the server. Client validation exists only for usability.

| Input surface                           | Attacker-controlled values                                                           | Primary risks                                                                                | Server requirements                                                                                                                                                      | Planned ticket |
| --------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| Landing form / checkout creation        | URL, Unicode domain, email, consent/policy version, request headers, network address | SSRF seed, parser confusion, oversized input, checkout spam, denial-of-wallet, false consent | Byte limits, strict JSON content type, Zod schema, canonical URL policy, email normalization, policy-version allowlist, rate limits, server-owned price                  | POR-9, POR-13  |
| Razorpay Checkout script and callback   | Script response, order/payment IDs, signature, callback timing                       | Script supply chain, forged client success, replay, UI confusion                             | Load only official script under CSP; verify server-side using server-stored order; callback never fulfills                                                               | POR-14         |
| Razorpay webhook                        | Raw bytes, signature header, event ID/type, nested order/payment/refund values       | Forgery, replay, duplicate/out-of-order events, amount substitution, oversized body          | Raw-body byte cap, HMAC verification before parsing/mutation, content type, schema, event-ID uniqueness, amount/currency/receipt reconciliation, monotonic state machine | POR-15         |
| QStash worker callback                  | Raw body, `Upstash-Signature`, JWT claims, URL, job/audit ID                         | Forged jobs, replay, body substitution, duplicate execution, cost amplification              | Byte cap; official receiver verifies current/next keys, issuer, subject URL, expiry/not-before and body hash; lease/idempotency in Postgres                              | POR-17         |
| Scheduled reconciler / cleanup callback | Signature, schedule metadata, job selector                                           | Forged cleanup/refund/replay trigger                                                         | Same QStash verification; fixed server-owned operation; no caller-provided SQL/filter; lease and bounded batch                                                           | POR-17, POR-27 |
| Auditing status route                   | Path audit ID, query/cache headers, polling frequency                                | Enumeration, IDOR, state leakage, traffic amplification                                      | Opaque ID, minimal status response, no email/payment/provider detail, rate limit, `no-store`, uniform not-found response                                                 | POR-21         |
| Private result route                    | Audit ID, capability token in URL/query, browser headers                             | Token theft, enumeration, IDOR, referrer/log/cache leakage                                   | At least 128-bit token; store keyed hash only; constant-time comparison; revocation; `no-store`, `noindex`, strict referrer policy; no third-party resources             | POR-22         |
| Scorecard/image route                   | Audit ID, report/image token, image params                                           | Report bypass, token leakage, injection into image, resource exhaustion                      | Valid report access or short-lived purpose-bound signature; fixed dimensions/template; text length limits; no remote assets from submitted page                          | POR-24         |
| Share action / product event            | Audit ID, event name, destination                                                    | Event forgery, analytics pollution, open redirect                                            | Allowlisted event enum and destination; valid capability; server-owned share URL; rate limit                                                                             | POR-24, POR-31 |
| Data-rights/contact request             | Email, audit/order reference, free text, attachments if later added                  | Impersonation, stored XSS, support abuse, accidental disclosure/deletion                     | No uploads in Phase 1; text byte/character limits; identity verification; escaped rendering; manual approval for irreversible provider deletion                          | POR-30         |
| ScreenshotOne response                  | Status, headers, content type, length, image bytes                                   | Decompression/size bomb, HTML/error treated as image, secret-bearing URL, malicious format   | Timeout, maximum bytes/dimensions, allowlisted raster type, decode validation, no response forwarding, no persistent URL/storage                                         | POR-16         |
| OpenAI response                         | Status, usage, structured text, refusal/incomplete state                             | Prompt injection effect, malformed output, stored XSS, false claims, cost amplification      | Strict structured output plus local schema; character bounds; plain-text rendering; evidence rubric; one repair attempt maximum                                          | POR-20, POR-19 |
| Resend webhook, if enabled              | Signature, event ID/type, recipient/delivery metadata                                | Forged bounce/complaint, PII leakage, replay                                                 | Verify using current official mechanism before mutation; event ID uniqueness; allowlisted schema; redact recipient in telemetry                                          | POR-25         |
| Error/observability input               | Exceptions, URLs, headers, provider bodies, breadcrumbs                              | Secret/PII leakage, log injection, attacker-controlled alert noise                           | Central pre-emission scrubber, structured fields, control-character removal, size caps, sampling/rate controls                                                           | POR-31         |

No user uploads, arbitrary filenames, raw HTML input, admin panel, authentication cookies, public report gallery, GraphQL endpoint, or user-controlled redirect destination exist in Phase 1. Adding any one reopens this threat model.

## Threat register

### TM-01: SSRF through submitted URLs

- Risk: Critical
- Scenario: An attacker submits localhost, cloud metadata, private network, link-local, unusual numeric IP, malicious IDN, or a domain resolving to a forbidden address. A server or provider becomes a proxy into protected infrastructure.
- Prevention: Parse once with the platform URL parser; allow only `http:` and `https:`; reject credentials, fragments, non-standard ports, IP literals where policy requires, and ambiguous forms; resolve all A/AAAA answers; reject private, loopback, link-local, multicast, reserved, documentation, carrier-grade NAT, unspecified, and IPv4-mapped IPv6 ranges; cap URL/hostname length; pass only the canonical URL onward. Direct application fetches use the validated IP/hostname relationship and constrained egress where available.
- Detection: Count rejected category and hashed target-domain signal; alert on metadata/private-range patterns and high rejection rate without logging the full sensitive URL query.
- Test: IPv4/IPv6 range table; decimal/hex/octal-like representations; userinfo confusion; trailing dot; mixed-case/punycode; IPv4-mapped IPv6; multiple DNS answers; oversized URL; parser differential fixtures.
- Residual risk: Public targets can still host malicious content or change after validation; serverless egress controls may be limited.
- Owner: POR-9 (security/backend)

### TM-02: DNS rebinding and time-of-check/time-of-use

- Risk: Critical
- Scenario: A domain resolves publicly during validation, then resolves to a private target when fetched or when a redirect is followed.
- Prevention: Re-resolve immediately before each application-owned network connection and verify every returned address; disable automatic redirects; resolve and revalidate every redirect destination; cap redirect count; reject address changes into forbidden ranges. For ScreenshotOne, apply the same preflight policy before submission and document that the external renderer's resolution is not pinned by RoastMyLP.
- Detection: Record redacted resolution category and validation/fetch mismatch; alert on rebinding-like changes.
- Test: Controlled DNS fixture alternates public/private answers; redirect chain changes host and address class; multi-answer DNS includes one forbidden address.
- Residual risk: ScreenshotOne performs its own later DNS resolution, so provider-side SSRF protections remain a dependency. No claim of complete DNS pinning is made for that path.
- Owner: POR-9 and POR-16

### TM-03: Redirect pivot or open redirect misuse

- Risk: High
- Scenario: An allowed public URL redirects to metadata/private infrastructure, an unsupported scheme, or a giant/hostile response. Separately, a user-supplied destination turns RoastMyLP into an open redirect.
- Prevention: Never automatically follow direct-fetch redirects; manually parse, normalize, resolve, and apply the full URL policy at each hop; maximum three hops; prohibit scheme downgrade where possible. Application navigation uses server-owned route IDs, never a caller-supplied destination URL.
- Detection: Metric for redirect rejection reason and chain length; alert on repeated cross-host/private pivots.
- Test: 30x to private IPv4/IPv6, metadata, credentialed URL, unsupported scheme, redirect loop, relative redirect, protocol-relative redirect, Unicode host.
- Residual risk: Legitimate sites with complex redirect/CDN flows may be rejected.
- Owner: POR-9

### TM-04: Forged, replayed, duplicate, or out-of-order Razorpay events

- Risk: Critical
- Scenario: An attacker forges payment success, replays a genuine webhook, changes amount/currency, or exploits event order so an earlier state overwrites captured/refunded state.
- Prevention: Verify checkout signature server-side using the stored order; webhook HMAC uses untouched raw bytes and a dedicated webhook secret; reject before parsing/mutation; unique `x-razorpay-event-id`; reconcile server-stored order, receipt, amount, currency, and provider payment state; enforce monotonic domain transitions; webhook acknowledges only after durable ledger write. Support current/previous webhook secret only during a documented rotation window.
- Detection: Alert on signature failure, duplicate rate, reconciliation mismatch, unknown event type, and attempted state regression. Do not log signatures or full payment bodies.
- Test: Known-good/bad HMAC fixtures, altered whitespace/body, repeated event ID, same semantic event with new ID, captured-before-authorized, failed-after-captured, amount/currency/receipt mismatch, oversized body.
- Residual risk: Provider compromise or account/dashboard takeover can produce correctly signed malicious events; provider/API reconciliation and account security are required.
- Owner: POR-14 and POR-15

### TM-05: Forged or duplicated QStash callbacks

- Risk: Critical
- Scenario: An attacker invokes the public worker directly, replays a valid callback, swaps its body, or causes concurrent deliveries that spend multiple screenshot/model calls.
- Prevention: Verify `Upstash-Signature` with current and next signing keys; validate JWT issuer, subject URL, `exp`, `nbf`, and SHA-256 body claim; use the raw body; accept only an opaque audit/job ID; enforce unique job identity, monotonic state and a transactional lease before spending; cap attempts.
- Detection: Alert on signature/claim/body-hash failure, lease contention, duplicate delivery, and attempts beyond budget.
- Test: Invalid key, expired/not-yet-valid token, wrong subject URL, body mutation, duplicate valid callback, parallel 20-request race, key rotation fixtures.
- Residual risk: Leaked QStash signing keys authorize forged deliveries until rotated; Postgres idempotency still prevents repeated fulfillment.
- Owner: POR-17

### TM-06: IDOR and audit enumeration

- Risk: High
- Scenario: A customer changes an audit ID in a status, result, scorecard, or event route and sees or acts on another audit.
- Prevention: Public status exposes only a minimal state keyed by an opaque identifier and is rate-limited. Report, scorecard, share-event, revocation, and deletion operations require a purpose-appropriate capability or verified customer identity. The report capability is independent of the audit ID and carries at least 128 bits of entropy. Missing, invalid, revoked, and wrong-audit tokens use the same response shape/timing envelope.
- Detection: Count invalid-token attempts by privacy-preserving network signal and target prefix; alert on enumeration patterns.
- Test: Swap IDs/tokens across audits, missing token, malformed token, revoked token, timing sampling, cached response, scorecard bypass, event forgery.
- Residual risk: Anyone receiving a deliberately forwarded report link can view it; this is an accepted capability-link property disclosed to customers.
- Owner: POR-21, POR-22, POR-24

### TM-07: Capability-token leakage

- Risk: High
- Scenario: A secret report token appears in browser history, `Referer`, server/CDN logs, analytics, Sentry, email scanners, screenshots, or shared scorecards.
- Prevention: Generate with a cryptographic RNG; store only a keyed hash; redact query strings globally; private routes use `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow, noarchive`, and `Referrer-Policy: no-referrer`; no third-party script/image/font on report pages; token is excluded from telemetry and scorecard; support revocation/rotation. Prefer a URL fragment-to-HttpOnly-cookie exchange only if a later design proves it reduces leakage without creating a new cookie/CSRF surface; Phase 1 starts with the explicitly accepted bearer link.
- Detection: Canary tests inspect logs, traces, analytics, response headers, browser requests, generated email, and image metadata for the token.
- Test: Navigate from report to external link, trigger error, inspect Vercel/Sentry logs and network, cache replay, email-link scanner request, share/download image scan.
- Residual risk: Mail providers, browser history, endpoint malware, and recipients can copy bearer links. Rotation/deletion limits future exposure but cannot undo prior viewing.
- Owner: POR-22, POR-25, POR-31

### TM-08: Indirect prompt injection from the submitted page

- Risk: High
- Scenario: Visible or hidden page text tells the model to ignore the rubric, reveal the system prompt, return attacker-chosen JSON, include secrets, or manipulate the score.
- Prevention: Treat screenshot/page content as quoted untrusted evidence; system/developer instruction states it cannot alter task/rules/output; the model has no tools, network, secrets, database access, or action authority; provide minimal context; strict schema plus local validation and content bounds; require each critique to cite observable page evidence; never place secrets in prompts; system prompt is not considered a secret control.
- Detection: Evaluation corpus includes visible/hidden multilingual injection; metric for schema repairs/refusals and anomalous repeated phrases; manual sampling of flagged reports.
- Test: Page images containing override instructions, fake JSON, system-prompt requests, encoded text, white-on-white text, QR-like text, and claims of payment/refund authority.
- Residual risk: Prompt injection cannot be perfectly eliminated; lack of agency and strict output handling constrain impact mainly to report quality.
- Owner: POR-20 and POR-19

### TM-09: Malformed or unsafe AI output / stored XSS

- Risk: High
- Scenario: The model or submitted page causes HTML, script, event handlers, Markdown links, control characters, oversized strings, prototype-polluting keys, or invalid values to be stored and rendered.
- Prevention: Strict closed schema; integer/enum/cardinality/character bounds; reject unknown keys and control characters; persist typed values; React text interpolation only; never `dangerouslySetInnerHTML`; no Markdown/MDX execution; safe JSON serialization; generated scorecard uses fixed text nodes; CSP provides defense in depth.
- Detection: Count schema rejection/repair; security event for active-markup patterns; CSP reports sampled without capability URLs.
- Test: `<script>`, SVG/onload, `javascript:` strings, Markdown images/links, `</script>` JSON breakouts, bidi controls, null bytes, huge Unicode, `__proto__`, malformed surrogate pairs.
- Residual risk: Harmful or defamatory plain-language content can pass structural validation; rubric, safety evaluation, complaint/removal path, and legal review address content risk.
- Owner: POR-19, POR-23, POR-24

### TM-10: Refund duplication and payment-state races

- Risk: Critical
- Scenario: Concurrent workers, webhooks, retries, or manual recovery create multiple refunds or refund a payment that later fulfills successfully.
- Prevention: Refund eligibility is a monotonic domain decision; one logical refund record and durable idempotency key per payment/reason; transactional compare-and-set before provider call; only captured payments can be refunded; reconcile provider state; fulfillment and terminal-failure transitions are mutually exclusive; manual action uses the same module/interface.
- Detection: Alert on multiple refund attempts, refund after completion, provider/local mismatch, and refund stuck outside terminal state.
- Test: Parallel refund calls, timeout after provider accepts, replay after crash, completed-vs-failed race, duplicate purchase, partial/unknown provider response.
- Residual risk: A provider timeout can leave outcome temporarily unknown; system must show `refund_pending`, not claim success, until reconciled.
- Owner: POR-18

### TM-11: Denial-of-wallet and resource exhaustion

- Risk: High
- Scenario: Automated checkouts, status polling, webhook replay, job invocation, giant pages, repeated screenshot/model calls, or high-token repair loops exhaust quotas or create unexpected bills.
- Prevention: Per-network and per-domain checkout limits; byte/time/dimension/redirect caps; only captured reconciled payment queues work; one job lease; provider attempt budgets; one AI repair maximum; response/token limits; bounded polling with backoff; QStash retry count configured explicitly; Redis budget cap; provider budget alerts/caps where available; no free unauthenticated roast endpoint.
- Detection: Cost per audit, attempts per audit, checkout-to-payment ratio, rejected input, queue depth, rate-limit hits, provider usage and latency alerts.
- Test: Load tests, repeated unpaid order creation, giant/slow page, screenshot timeout, model 429/5xx, 20 concurrent worker callbacks, endless invalid JSON fixture, aggressive polling.
- Residual risk: Distributed low-rate abuse and paid malicious purchases can consume capacity; launch capacity and provider budgets intentionally cap exposure.
- Owner: POR-13, POR-17, POR-19, POR-31, POR-28

### TM-12: Sensitive-data and secret leakage through logs

- Risk: High
- Scenario: Framework/provider errors capture full URLs, emails, raw webhook bodies, payment identifiers, signatures, capability tokens, screenshot bytes, AI inputs/outputs, or environment secrets.
- Prevention: Central structured logger with allowlisted fields; redact before emission; never log request bodies for payment/worker/result routes; strip query strings and authorization/signature headers; hash network/domain abuse signals with rotating keyed salt; disable Sentry default PII; sanitize exception messages and breadcrumbs; enforce length/control-character limits to prevent log injection.
- Detection: CI secret scan plus runtime canary values; scheduled audit of Vercel/Sentry samples; alert on forbidden field names/patterns in the log pipeline.
- Test: Synthetic email/token/API-key markers through every failure path, malicious newline/control characters, provider body echo, thrown URL object, Sentry event snapshot.
- Residual risk: Platform edge logs may record request paths before application scrubbing; private tokens must not be placed in path segments, and platform configuration requires POR-31/POR-11 verification.
- Owner: POR-31

### TM-13: Third-party browser script compromise

- Risk: High
- Scenario: Compromised Razorpay Checkout JavaScript reads form data, changes payment UX, or runs arbitrary code under the site origin.
- Prevention: Load Checkout only on the payment interaction route/from the official origin; restrictive CSP and `frame-src`; minimize data present in DOM; no report token on a page loading Checkout; never self-host a stale copy; monitor provider security notices. Subresource Integrity is not assumed because a vendor-updated third-party script cannot use a stable hash safely without provider support.
- Detection: CSP reporting, dependency/integration smoke test, unexpected script-origin monitoring.
- Test: CSP blocks unlisted script/frame/connect origins; report page contains no Razorpay script; checkout still functions under production CSP.
- Residual risk: An authorized third-party origin is executable trust. Hosted redirect/payment-page alternatives should be reconsidered if CSP isolation is insufficient.
- Owner: POR-14 and POR-29

### TM-14: Cross-site request abuse

- Risk: Medium
- Scenario: Another site causes a browser to create checkouts or product events, or exploits future cookies to perform state-changing operations.
- Prevention: State-changing browser routes accept only JSON with a custom request header, enforce exact production/staging `Origin`, deny permissive CORS, inspect Fetch Metadata where reliable, and never mutate on GET. Capability-bearing operations still validate the capability. Webhooks/workers are explicitly exempt from browser-origin rules and use cryptographic authentication instead. No authentication cookie is planned in Phase 1.
- Detection: Metric for rejected origin/fetch-metadata/content-type; alert on cross-site bursts.
- Test: Cross-origin simple form/text request, missing/wrong Origin, missing custom header, OPTIONS behavior, webhook unaffected by browser-origin policy.
- Residual risk: Browser extensions or same-origin XSS bypass origin checks; XSS prevention and CSP remain essential.
- Owner: POR-13, POR-24, POR-29

### TM-15: Provider response spoofing, downgrade, or exceptional-condition failure

- Risk: High
- Scenario: A network/provider error is treated as success, HTML error as image/JSON, stale state as current, or an unknown exception leaves a paid audit permanently stuck.
- Prevention: HTTPS only; verify webhook/callback signatures; allowlist status/content type and bound body; typed provider adapters return classified results; default unknown response to retriable failure, not success; explicit timeouts; durable attempt record before side effect; reconciler owns stuck states.
- Detection: Provider error-rate/shape-change alerts, unknown-classification metric, stuck-state age alerts.
- Test: HTML 200 error, truncated image, JSON shape drift, timeout before/after side effect, TLS/network reset, unexpected status, empty body, oversized body.
- Residual risk: Provider control-plane compromise can return plausible signed/HTTPS data; reconciliation and anomaly monitoring reduce but do not remove it.
- Owner: POR-16, POR-17, POR-19, POR-25

### TM-16: Email-based disclosure and abuse

- Risk: Medium
- Scenario: A mistyped/attacker email receives a report; forwarding or mail scanning opens a capability link; attacker uses the product to send unwanted email.
- Prevention: Confirm email syntax and require it twice only if UX testing supports the friction; email is bound to the paid order; rate-limit checkout; transactional content only; SPF/DKIM/DMARC; capability can be revoked; no report content in subject; no marketing inference.
- Detection: Bounce/complaint rates, repeated recipients/domains, anomalous checkout-to-email patterns.
- Test: Typo/bounce, complaint webhook, duplicate delivery retry, scanner prefetch, forwarded link, Unicode email edge policy.
- Residual risk: Without pre-payment email OTP, ownership of the address is not proven. This is an accepted no-account tradeoff requiring a support/revocation path.
- Owner: POR-25 and POR-30

## Required HTTP response policy

Final values must be verified with Razorpay Checkout and Next.js in staging. Security headers are server-owned and tested; HTML meta tags are not substitutes.

### Public marketing and checkout pages

- `Content-Security-Policy`: begin in Report-Only during staging, then enforce. Baseline: `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://checkout.razorpay.com 'nonce-{per-response-value}'; frame-src https://api.razorpay.com https://*.razorpay.com; connect-src 'self' https://api.razorpay.com https://*.razorpay.com; img-src 'self' data:; style-src 'self' 'nonce-{per-response-value}'; font-src 'self'; upgrade-insecure-requests`. Exact Razorpay origins observed in staging are allowlisted individually; wildcards are narrowed where documentation/traffic permits.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` after confirming every subdomain is HTTPS. Add `preload` only after meeting preload requirements and accepting irreversibility.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(self), usb=(), serial=(), bluetooth=(), browsing-topics=()`; payment feature policy is adjusted only if Razorpay testing proves a narrower required delegation.
- `X-Content-Type-Options: nosniff`.
- `X-Frame-Options: DENY` as legacy defense; CSP `frame-ancestors` is authoritative.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` only if required for Razorpay; otherwise `same-origin`.
- `Cross-Origin-Resource-Policy: same-origin` for application-owned resources where compatible.
- No permissive `Access-Control-Allow-Origin`; browser interfaces are same-origin.

### Private report, status, and scorecard responses

- All applicable headers above, with no Razorpay/third-party script or frame origins.
- `Referrer-Policy: no-referrer`.
- `Cache-Control: private, no-store, max-age=0` and appropriate CDN override to prevent storage.
- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`.
- CSP `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'nonce-{per-response-value}'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'nonce-{per-response-value}'; font-src 'self'`.
- Do not use third-party analytics, fonts, images, scripts, error widgets, or share SDKs on token-bearing pages.

### Webhooks and worker routes

- Accept only `POST`; return `405` for other methods.
- Enforce endpoint-specific byte limit before parsing.
- `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- No CORS headers.
- Browser `Origin`/CSRF checks do not authenticate these routes; provider signatures do.
- Error responses are constant, minimal, and contain no verification detail.

## Detection and response baseline

Security telemetry uses correlation IDs and allowlisted structured fields. It records event category, result, redacted actor/network signal, audit/job reference safe for operations, attempt number, latency, and timestamp. It does not record raw email, capability token, signature, authorization header, screenshot, AI prompt/output, or full webhook body.

Minimum alerts before launch:

- Razorpay or QStash signature failures above baseline.
- Amount/currency/order reconciliation mismatch.
- Repeated URL-policy rejects for metadata/private ranges.
- Duplicate/concurrent worker or refund attempts.
- Paid audit stuck beyond its state threshold.
- Audit success rate below 95% or cost/attempt budget exceeded.
- Forbidden canary detected in logs/Sentry.
- CSP violation from an unapproved script/frame origin.

Incident response and breach notification procedures are separate launch-blocker deliverables. An alert is not a recovery mechanism; durable reconciliation is.

## Verification matrix for POR-10

- [x] Forms, route parameters, query values, payment callbacks, webhooks, provider responses, email links, logs, and rendered AI output are inventoried.
- [x] SSRF, DNS rebinding, redirect pivots, webhook forgery/replay, IDOR, token leakage, prompt injection, stored XSS, refund duplication, log leakage, and denial-of-wallet are modeled.
- [x] Every threat has prevention, detection, tests, residual risk, and owner.
- [x] CSP, HSTS, Referrer-Policy, Permissions-Policy, MIME sniffing, framing, caching, robots, and cross-origin policy are specified.
- [x] No listed control relies solely on browser/client validation.

## Sources checked

Primary/official sources were checked live on 2026-08-23:

- OWASP Top 10:2025: https://owasp.org/Top10/
- OWASP GenAI/LLM Top 10 current release (2026 published 2026-08-04): https://owasp.org/www-project-top-10-for-large-language-model-applications/
- OWASP SSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- OWASP CSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- OWASP Unvalidated Redirects and Forwards Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html
- Razorpay Standard Checkout: https://razorpay.com/docs/developer-tools/integrations/standard-checkout/
- Razorpay webhook validation, duplicate IDs, and event ordering: https://razorpay.com/docs/webhooks/validate-test/
- Upstash QStash signature verification: https://upstash.com/docs/qstash/howto/signature
- Upstash QStash retry behavior: https://upstash.com/docs/qstash/api-reference/messages/publish-a-message
- Next.js response headers: https://nextjs.org/docs/app/api-reference/config/next-config-js/headers
- Next.js CSP guide: https://nextjs.org/docs/app/guides/content-security-policy
