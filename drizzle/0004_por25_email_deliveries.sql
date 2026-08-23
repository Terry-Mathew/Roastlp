CREATE TYPE "public"."email_kind" AS ENUM('result', 'processing_failure', 'refund_completed');--> statement-breakpoint
CREATE TYPE "public"."email_state" AS ENUM('pending', 'sent', 'failed', 'bounced', 'complained');--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roast_id" uuid NOT NULL,
	"kind" "email_kind" NOT NULL,
	"state" "email_state" DEFAULT 'pending' NOT NULL,
	"idempotency_key_hash" varchar(64) NOT NULL,
	"provider_message_id" varchar(128),
	"last_error_code" varchar(64),
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_deliveries_idempotency_key_unique" UNIQUE("idempotency_key_hash"),
	CONSTRAINT "email_deliveries_provider_message_unique" UNIQUE("provider_message_id"),
	CONSTRAINT "email_deliveries_roast_kind_unique" UNIQUE("roast_id","kind"),
	CONSTRAINT "email_deliveries_key_hash_check" CHECK ("email_deliveries"."idempotency_key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_roast_id_roasts_id_fk" FOREIGN KEY ("roast_id") REFERENCES "public"."roasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_deliveries_state_created_idx" ON "email_deliveries" USING btree ("state","created_at");