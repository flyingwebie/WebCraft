CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"recipient" text NOT NULL,
	"person_id" uuid,
	"subject" text NOT NULL,
	"smtp" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_response" text,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"related_kind" text,
	"related_id" text,
	CONSTRAINT "email_log_status_known" CHECK ("status" in ('queued', 'retrying', 'sent', 'failed', 'logged'))
);
--> statement-breakpoint
CREATE TABLE "email_opt_outs" (
	"person_id" uuid,
	"type" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_opt_outs_pkey" PRIMARY KEY("person_id","type")
);
--> statement-breakpoint
CREATE TABLE "install_smtp" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"security" text NOT NULL,
	"username" text,
	"from_address" text NOT NULL,
	"reply_to" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "install_smtp_single_row" CHECK ("id" = 1),
	CONSTRAINT "install_smtp_security_known" CHECK ("security" in ('starttls', 'tls', 'none')),
	CONSTRAINT "install_smtp_port_range" CHECK ("port" between 1 and 65535)
);
--> statement-breakpoint
CREATE TABLE "smtp_health" (
	"smtp" text PRIMARY KEY,
	"failures_in_a_row" integer DEFAULT 0 NOT NULL,
	"failing_since" timestamp with time zone,
	"last_response" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "email_sender_name" text;--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "email_logo_url" text;--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "email_accent_colour" text;--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "email_footer" text;--> statement-breakpoint
CREATE INDEX "email_log_created_at_idx" ON "email_log" ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "email_opt_outs" ADD CONSTRAINT "email_opt_outs_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "install_smtp" ADD CONSTRAINT "install_smtp_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;