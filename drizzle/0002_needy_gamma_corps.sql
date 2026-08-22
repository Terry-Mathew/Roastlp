CREATE TYPE "public"."checkout_attempt_state" AS ENUM('order_creating', 'order_created', 'failed');--> statement-breakpoint
CREATE TABLE "checkout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roast_id" uuid NOT NULL,
	"state" "checkout_attempt_state" DEFAULT 'order_creating' NOT NULL,
	"request_key_hash" varchar(64) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"receipt" varchar(40) NOT NULL,
	"razorpay_order_id" varchar(64),
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_attempts_roast_unique" UNIQUE("roast_id"),
	CONSTRAINT "checkout_attempts_request_key_unique" UNIQUE("request_key_hash"),
	CONSTRAINT "checkout_attempts_receipt_unique" UNIQUE("receipt"),
	CONSTRAINT "checkout_attempts_order_unique" UNIQUE("razorpay_order_id"),
	CONSTRAINT "checkout_attempts_key_hash_check" CHECK ("checkout_attempts"."request_key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "checkout_attempts_fingerprint_check" CHECK ("checkout_attempts"."request_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "roasts" ADD COLUMN "terms_version" varchar(64) DEFAULT 'pre-por-13' NOT NULL;--> statement-breakpoint
ALTER TABLE "roasts" ADD COLUMN "refund_policy_version" varchar(64) DEFAULT 'pre-por-13' NOT NULL;--> statement-breakpoint
ALTER TABLE "roasts" ALTER COLUMN "terms_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "roasts" ALTER COLUMN "refund_policy_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_roast_id_roasts_id_fk" FOREIGN KEY ("roast_id") REFERENCES "public"."roasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_attempts_state_created_idx" ON "checkout_attempts" USING btree ("state","created_at");
