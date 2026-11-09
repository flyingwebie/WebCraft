CREATE TABLE "consent_banners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL CONSTRAINT "consent_banners_site_id_unique" UNIQUE,
	"mode" text DEFAULT 'optIn' NOT NULL,
	"layout" text DEFAULT 'bar' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"choices" jsonb NOT NULL,
	"banner_version" integer NOT NULL,
	"language" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "consent_records_site_id_idx" ON "consent_records" ("site_id");--> statement-breakpoint
CREATE INDEX "consent_records_created_at_idx" ON "consent_records" ("created_at");--> statement-breakpoint
ALTER TABLE "consent_banners" ADD CONSTRAINT "consent_banners_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;