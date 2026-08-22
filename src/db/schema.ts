import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const roastState = pgEnum("roast_state", [
  "awaiting_payment",
  "ready_for_fulfillment",
  "queued",
  "processing",
  "completed",
  "terminal_failure",
  "refund_pending",
  "refunded",
  "deleted",
]);

export const paymentState = pgEnum("payment_state", [
  "created",
  "authorized",
  "captured",
  "failed",
  "partially_refunded",
  "refunded",
]);

export const checkoutAttemptState = pgEnum("checkout_attempt_state", [
  "order_creating",
  "order_created",
  "failed",
]);

export const auditJobState = pgEnum("audit_job_state", [
  "pending",
  "leased",
  "retry_scheduled",
  "succeeded",
  "failed",
  "cancelled",
]);

export const jobAttemptState = pgEnum("job_attempt_state", [
  "running",
  "succeeded",
  "retryable_failure",
  "terminal_failure",
]);

export const jobStage = pgEnum("job_stage", [
  "capture",
  "analyze",
  "persist_report",
  "deliver_email",
  "reconcile",
]);

export const webhookState = pgEnum("webhook_state", [
  "received",
  "processing",
  "processed",
  "failed",
  "rejected",
]);

export const refundState = pgEnum("refund_state", [
  "requested",
  "processing",
  "succeeded",
  "failed",
]);

export const productEventName = pgEnum("product_event_name", [
  "checkout_created",
  "payment_captured",
  "roast_completed",
  "roast_failed",
  "refund_requested",
  "refund_completed",
  "result_email_sent",
  "scorecard_downloaded",
  "share_clicked",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const roasts = pgTable(
  "roasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: roastState("state").notNull().default("awaiting_payment"),
    submittedUrl: text("submitted_url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    hostname: text("hostname").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    consentVersion: varchar("consent_version", { length: 64 }).notNull(),
    privacyNoticeVersion: varchar("privacy_notice_version", {
      length: 64,
    }).notNull(),
    termsVersion: varchar("terms_version", { length: 64 }).notNull(),
    refundPolicyVersion: varchar("refund_policy_version", {
      length: 64,
    }).notNull(),
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
    terminalErrorCode: varchar("terminal_error_code", { length: 64 }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("roasts_state_created_idx").on(table.state, table.createdAt),
    index("roasts_hostname_created_idx").on(table.hostname, table.createdAt),
    check(
      "roasts_normalized_email_check",
      sql`${table.normalizedEmail} = lower(btrim(${table.normalizedEmail}))`,
    ),
    check(
      "roasts_deleted_state_check",
      sql`(${table.state} = 'deleted' AND ${table.deletedAt} IS NOT NULL) OR (${table.state} <> 'deleted' AND ${table.deletedAt} IS NULL)`,
    ),
  ],
);

export const checkoutAttempts = pgTable(
  "checkout_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roastId: uuid("roast_id")
      .notNull()
      .references(() => roasts.id, { onDelete: "restrict" }),
    state: checkoutAttemptState("state").notNull().default("order_creating"),
    requestKeyHash: varchar("request_key_hash", { length: 64 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    receipt: varchar("receipt", { length: 40 }).notNull(),
    razorpayOrderId: varchar("razorpay_order_id", { length: 64 }),
    errorCode: varchar("error_code", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    unique("checkout_attempts_roast_unique").on(table.roastId),
    unique("checkout_attempts_request_key_unique").on(table.requestKeyHash),
    unique("checkout_attempts_receipt_unique").on(table.receipt),
    unique("checkout_attempts_order_unique").on(table.razorpayOrderId),
    index("checkout_attempts_state_created_idx").on(
      table.state,
      table.createdAt,
    ),
    check(
      "checkout_attempts_key_hash_check",
      sql`${table.requestKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "checkout_attempts_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roastId: uuid("roast_id")
      .notNull()
      .references(() => roasts.id, { onDelete: "restrict" }),
    state: paymentState("state").notNull().default("created"),
    razorpayOrderId: varchar("razorpay_order_id", { length: 64 }).notNull(),
    razorpayPaymentId: varchar("razorpay_payment_id", { length: 64 }),
    receipt: varchar("receipt", { length: 64 }).notNull(),
    amountPaise: integer("amount_paise").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("INR"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("payments_razorpay_order_unique").on(table.razorpayOrderId),
    unique("payments_razorpay_payment_unique").on(table.razorpayPaymentId),
    unique("payments_receipt_unique").on(table.receipt),
    index("payments_roast_created_idx").on(table.roastId, table.createdAt),
    check("payments_phase_1_amount_check", sql`${table.amountPaise} = 19900`),
    check("payments_currency_check", sql`${table.currency} = 'INR'`),
  ],
);

export const auditJobs = pgTable(
  "audit_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roastId: uuid("roast_id")
      .notNull()
      .references(() => roasts.id, { onDelete: "restrict" }),
    state: auditJobState("state").notNull().default("pending"),
    qstashMessageId: varchar("qstash_message_id", { length: 128 }),
    leaseTokenHash: varchar("lease_token_hash", { length: 64 }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    terminalErrorCode: varchar("terminal_error_code", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    unique("audit_jobs_roast_unique").on(table.roastId),
    unique("audit_jobs_qstash_message_unique").on(table.qstashMessageId),
    index("audit_jobs_recovery_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditJobId: uuid("audit_job_id")
      .notNull()
      .references(() => auditJobs.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    stage: jobStage("stage").notNull(),
    state: jobAttemptState("state").notNull().default("running"),
    errorCode: varchar("error_code", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("job_attempts_job_number_unique").on(
      table.auditJobId,
      table.attemptNumber,
    ),
    check(
      "job_attempts_number_positive_check",
      sql`${table.attemptNumber} > 0`,
    ),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    state: webhookState("state").notNull().default("received"),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    verifiedPayload: jsonb("verified_payload").notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    unique("webhook_provider_event_unique").on(
      table.provider,
      table.providerEventId,
    ),
    index("webhook_state_received_idx").on(table.state, table.receivedAt),
    check(
      "webhook_payload_digest_check",
      sql`${table.payloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    state: refundState("state").notNull().default("requested"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    razorpayRefundId: varchar("razorpay_refund_id", { length: 64 }),
    amountPaise: integer("amount_paise").notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("refunds_idempotency_key_unique").on(table.idempotencyKey),
    unique("refunds_razorpay_refund_unique").on(table.razorpayRefundId),
    index("refunds_payment_created_idx").on(table.paymentId, table.createdAt),
    check("refunds_amount_positive_check", sql`${table.amountPaise} > 0`),
  ],
);

export const reportAccessGrants = pgTable(
  "report_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roastId: uuid("roast_id")
      .notNull()
      .references(() => roasts.id, { onDelete: "restrict" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("report_access_one_active_roast_unique")
      .on(table.roastId)
      .where(sql`${table.revokedAt} IS NULL`),
    unique("report_access_token_hash_unique").on(table.tokenHash),
    check(
      "report_access_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const productEvents = pgTable(
  "product_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roastId: uuid("roast_id").references(() => roasts.id, {
      onDelete: "set null",
    }),
    name: productEventName("name").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("product_events_name_occurred_idx").on(table.name, table.occurredAt),
    index("product_events_roast_occurred_idx").on(
      table.roastId,
      table.occurredAt,
    ),
  ],
);

export type RoastRecord = typeof roasts.$inferSelect;
export type PaymentRecord = typeof payments.$inferSelect;
export type CheckoutAttemptRecord = typeof checkoutAttempts.$inferSelect;
export type AuditJobRecord = typeof auditJobs.$inferSelect;
export type JobAttemptRecord = typeof jobAttempts.$inferSelect;
export type WebhookEventRecord = typeof webhookEvents.$inferSelect;
export type RefundRecord = typeof refunds.$inferSelect;
