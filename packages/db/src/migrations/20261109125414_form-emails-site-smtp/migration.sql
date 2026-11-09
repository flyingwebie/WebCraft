CREATE TABLE "site_smtp" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid PRIMARY KEY,
	"from_name" text,
	"reply_to" text,
	"host" text,
	"port" integer,
	"security" text,
	"username" text,
	"from_address" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "site_smtp_server_whole" CHECK (("host" is null) = ("port" is null) and ("host" is null) = ("security" is null) and ("host" is null) = ("from_address" is null)),
	CONSTRAINT "site_smtp_security_known" CHECK ("security" is null or "security" in ('starttls', 'tls', 'none')),
	CONSTRAINT "site_smtp_port_range" CHECK ("port" is null or "port" between 1 and 65535)
);
--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "site_id" uuid;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "emails_draft" jsonb;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "emails_published" jsonb;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "emails_last_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "related_kind" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "related_id" text;--> statement-breakpoint
CREATE INDEX "email_log_related_idx" ON "email_log" ("related_kind","related_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_related_idx" ON "webhook_deliveries" ("site_id","related_kind","related_id");--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_site_id_sites_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "site_smtp" ADD CONSTRAINT "site_smtp_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "site_smtp" ADD CONSTRAINT "site_smtp_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;