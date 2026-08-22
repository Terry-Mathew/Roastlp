# Use a durable receipt ledger across the database and Razorpay boundary

- Status: Accepted for POR-13
- Date: 2026-08-23

RoastMyLP commits a pending Roast and Checkout Attempt before contacting Razorpay. A client-generated high-entropy request key is stored only as an HMAC, bound to the canonical URL, normalized email, and exact policy versions by a separate HMAC fingerprint. The attempt owns a deterministic opaque receipt, which is unique in PostgreSQL and sent to Razorpay.

PostgreSQL cannot atomically commit a remote Razorpay order. We therefore keep database transactions short and never hold one across the provider call. After an ambiguous timeout or crash, the application queries Razorpay by the same receipt before attempting creation. Provider responses are accepted only when their order type, receipt, ₹199 amount, INR currency, unpaid amount, and created state match the server-owned contract.

Independent HMAC-pseudonymized IP and canonical-domain sliding-window limits run before persistence or provider spend. Redis timeout or failure is fail-closed. Raw IPs, email addresses, URLs, provider bodies, credentials, and request keys are excluded from the abuse store and routine logs.

Live order creation remains disabled unless `CHECKOUT_ENABLED=true` and every required environment variable is present. Browser payment success is never payment authority; POR-14 and POR-15 own server verification and captured-payment webhooks.

## Current primary sources

- [Razorpay Orders API](https://razorpay.com/docs/api/orders/create/?preferred-country=IN)
- [Razorpay Standard Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
- [Razorpay API authentication](https://razorpay.com/docs/api/authentication/)
- [PostgreSQL unique constraints](https://www.postgresql.org/docs/18/ddl-constraints.html)
- [Drizzle transactions](https://orm.drizzle.team/docs/transactions)
- [Vercel request headers](https://vercel.com/docs/headers/request-headers)
- [Upstash rate-limit algorithms](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms)
- [DPDP Act and commencement material](https://www.meity.gov.in/data-protection-framework)

## Residual launch gates

The production WAF checkout rule, Test Mode Razorpay behavior, automatic-capture setting, live/test credential separation, and final policy/legal text require dashboard evidence or professional review before live payments are enabled.
