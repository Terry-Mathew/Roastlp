CREATE TABLE "roast_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roast_id" uuid NOT NULL,
	"report" jsonb NOT NULL,
	"model" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roast_reports_roast_unique" UNIQUE("roast_id")
);
--> statement-breakpoint
ALTER TABLE "roast_reports" ADD CONSTRAINT "roast_reports_roast_id_roasts_id_fk" FOREIGN KEY ("roast_id") REFERENCES "public"."roasts"("id") ON DELETE restrict ON UPDATE no action;