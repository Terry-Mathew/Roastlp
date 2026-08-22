# RoastMyLP

RoastMyLP sells one automated conversion critique of a publicly reachable landing page. This language keeps the purchase and fulfilment flow precise without implying account ownership or human review.

## Language

**Submitted URL**:
The exact URL supplied by a customer before validation.
_Avoid_: Website, link

**Canonical target**:
The normalized, public HTTP or HTTPS URL approved for screenshot capture or another outbound request.
_Avoid_: Clean URL, safe link

**Resolved address**:
An IP address returned for a canonical target's hostname and approved as globally reachable.
_Avoid_: Server IP

**Redirect target**:
A URL derived from a response location and required to pass the same validation as the original submitted URL.
_Avoid_: Forwarded link

**Roast**:
The purchased unit that tracks one canonical target from payment through delivery or refund.
_Avoid_: Account, order, professional review

**Payment**:
The Razorpay payment lifecycle associated with a Roast. It is evidence of money movement, not proof that fulfilment completed.
_Avoid_: Purchase status

**Audit Job**:
The single durable fulfilment job for a paid Roast.
_Avoid_: Queue message, task

**Job Attempt**:
One leased execution of an Audit Job, including its outcome and retry classification.
_Avoid_: Retry, run

**Webhook Event**:
One verified provider event recorded by its provider-issued identifier before business processing.
_Avoid_: Callback

**Refund**:
The independently reconciled return of money for a captured Payment.
_Avoid_: Cancellation

**Report Access Grant**:
A revocable bearer capability for one completed Roast; only its cryptographic hash is retained.
_Avoid_: Login, report password

**Product Event**:
A fixed, customer-safe measurement event without arbitrary properties or direct contact data.
_Avoid_: Analytics payload, tracking profile
