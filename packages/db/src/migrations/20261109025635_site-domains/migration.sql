CREATE TABLE "site_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"language" text,
	"verified_at" timestamp with time zone,
	"verify_round" integer DEFAULT 0 NOT NULL,
	"verify_started_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_problem" text,
	"unreachable_since" timestamp with time zone,
	"certificate_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "site_domains_name_unique" ON "site_domains" ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "site_domains_one_primary" ON "site_domains" ("site_id") WHERE "role" = 'primary';--> statement-breakpoint
CREATE UNIQUE INDEX "site_domains_one_per_language" ON "site_domains" ("site_id","language");--> statement-breakpoint
CREATE INDEX "site_domains_next_check_at_idx" ON "site_domains" ("next_check_at");--> statement-breakpoint
ALTER TABLE "site_domains" ADD CONSTRAINT "site_domains_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "site_domains" ADD CONSTRAINT "site_domains_language_fkey" FOREIGN KEY ("site_id","language") REFERENCES "site_languages"("site_id","code") ON DELETE CASCADE;