# Separate money, fulfilment, delivery, and access lifecycles

A Roast does not use one catch-all status: Payment, Audit Job, Job Attempt, Webhook Event, Refund, and Report Access Grant each retain an independent durable lifecycle linked to the Roast. This costs more tables and explicit reconciliation, but prevents delayed provider events or retries from regressing unrelated business state and preserves enough evidence to recover idempotently.
