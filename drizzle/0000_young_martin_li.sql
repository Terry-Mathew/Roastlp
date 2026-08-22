CREATE TYPE "public"."audit_job_state" AS ENUM('pending', 'leased', 'retry_scheduled', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_attempt_state" AS ENUM('running', 'succeeded', 'retryable_failure', 'terminal_failure');--> statement-breakpoint
CREATE TYPE "public"."job_stage" AS ENUM('capture', 'analyze', 'persist_report', 'deliver_email', 'reconcile');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('created', 'authorized', 'captured', 'failed', 'partially_refunded', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."product_event_name" AS ENUM('checkout_created', 'payment_captured', 'roast_completed', 'roast_failed', 'refund_requested', 'refund_completed', 'result_email_sent', 'scorecard_downloaded', 'share_clicked');--> statement-breakpoint
CREATE TYPE "public"."refund_state" AS ENUM('requested', 'processing', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."roast_state" AS ENUM('awaiting_payment', 'ready_for_fulfillment', 'queued', 'processing', 'completed', 'terminal_failure', 'refund_pending', 'refunded', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."webhook_state" AS ENUM('received', 'processing', 'processed', 'failed', 'rejected');--> statement-breakpoint
CREATE TABLE "audit_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roast_id" uuid NOT NULL,
	"state" "audit_job_state" DEFAULT 'pending' NOT NULL,
	"qstash_message_id" varchar(128),
	"lease_token_hash" varchar(64),
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"terminal_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_jobs_roast_unique" UNIQUE("roast_id"),
	CONSTRAINT "audit_jobs_qstash_message_unique" UNIQUE("qstash_message_id")
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"stage" "job_stage" NOT NULL,
	"state" "job_attempt_state" DEFAULT 'running' NOT NULL,
	"error_code" varchar(64),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "job_attempts_job_number_unique" UNIQUE("audit_job_id","attempt_number"),
	CONSTRAINT "job_attempts_number_positive_check" CHECK ("job_attempts"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roast_id" uuid NOT NULL,
	"state" "payment_state" DEFAULT 'created' NOT NULL,
	"razorpay_order_id" varchar(64) NOT NULL,
	"razorpay_payment_id" varchar(64),
	"receipt" varchar(64) NOT NULL,
	"amount_paise" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"captured_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_razorpay_order_unique" UNIQUE("razorpay_order_id"),
	CONSTRAINT "payments_razorpay_payment_unique" UNIQUE("razorpay_payment_id"),
	CONSTRAINT "payments_receipt_unique" UNIQUE("receipt"),
	CONSTRAINT "payments_phase_1_amount_check" CHECK ("payments"."amount_paise" = 19900),
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" = 'INR')
);
--> statement-breakpoint
CREATE TABLE "product_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roast_id" uuid,
	"name" "product_event_name" NOT NULL,
	"correlation_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"state" "refund_state" DEFAULT 'requested' NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"razorpay_refund_id" varchar(64),
	"amount_paise" integer NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"error_code" varchar(64),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "refunds_razorpay_refund_unique" UNIQUE("razorpay_refund_id"),
	CONSTRAINT "refunds_amount_positive_check" CHECK ("refunds"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "report_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roast_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "report_access_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "report_access_token_hash_check" CHECK ("report_access_grants"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "roasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" "roast_state" DEFAULT 'awaiting_payment' NOT NULL,
	"submitted_url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"hostname" text NOT NULL,
	"normalized_email" text NOT NULL,
	"consent_version" varchar(64) NOT NULL,
	"privacy_notice_version" varchar(64) NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"terminal_error_code" varchar(64),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roasts_normalized_email_check" CHECK ("roasts"."normalized_email" = lower(btrim("roasts"."normalized_email"))),
	CONSTRAINT "roasts_deleted_state_check" CHECK (("roasts"."state" = 'deleted' AND "roasts"."deleted_at" IS NOT NULL) OR ("roasts"."state" <> 'deleted' AND "roasts"."deleted_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_event_id" varchar(128) NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"state" "webhook_state" DEFAULT 'received' NOT NULL,
	"payload_digest" varchar(64) NOT NULL,
	"verified_payload" jsonb NOT NULL,
	"error_code" varchar(64),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_provider_event_unique" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "webhook_payload_digest_check" CHECK ("webhook_events"."payload_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "audit_jobs" ADD CONSTRAINT "audit_jobs_roast_id_roasts_id_fk" FOREIGN KEY ("roast_id") REFERENCES "public"."roasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_audit_job_id_audit_jobs_id_fk" FOREIGN KEY ("audit_job_id") REFERENCES "public"."audit_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_roast_id_roasts_id_fk" FOREIGN KEY ("roast_id") REFERENCES "public"."roasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_roast_id_roasts_id_fk" FOREIGN KEY ("roast_id") REFERENCES "public"."roasts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_access_grants" ADD CONSTRAINT "report_access_grants_roast_id_roasts_id_fk" FOREIGN KEY ("roast_id") REFERENCES "public"."roasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_jobs_recovery_idx" ON "audit_jobs" USING btree ("state","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "payments_roast_created_idx" ON "payments" USING btree ("roast_id","created_at");--> statement-breakpoint
CREATE INDEX "product_events_name_occurred_idx" ON "product_events" USING btree ("name","occurred_at");--> statement-breakpoint
CREATE INDEX "product_events_roast_occurred_idx" ON "product_events" USING btree ("roast_id","occurred_at");--> statement-breakpoint
CREATE INDEX "refunds_payment_created_idx" ON "refunds" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_access_one_active_roast_unique" ON "report_access_grants" USING btree ("roast_id") WHERE "report_access_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "roasts_state_created_idx" ON "roasts" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "roasts_hostname_created_idx" ON "roasts" USING btree ("hostname","created_at");--> statement-breakpoint
CREATE INDEX "webhook_state_received_idx" ON "webhook_events" USING btree ("state","received_at");