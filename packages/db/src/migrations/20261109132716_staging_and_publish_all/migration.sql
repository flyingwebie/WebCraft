CREATE TABLE "staging_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"admin_session_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staging_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"admin_session_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_banners" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "globals" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "design_systems" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "staging_password_hash" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "staging_password_changed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "staging_links_expires_at_idx" ON "staging_links" ("expires_at");--> statement-breakpoint
CREATE INDEX "staging_sessions_admin_session_id_idx" ON "staging_sessions" ("admin_session_id");--> statement-breakpoint
CREATE INDEX "staging_sessions_expires_at_idx" ON "staging_sessions" ("expires_at");--> statement-breakpoint
ALTER TABLE "consent_banners" ADD CONSTRAINT "consent_banners_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "globals" ADD CONSTRAINT "globals_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD CONSTRAINT "loops_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "design_systems" ADD CONSTRAINT "design_systems_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "staging_links" ADD CONSTRAINT "staging_links_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "staging_links" ADD CONSTRAINT "staging_links_admin_session_id_sessions_id_fkey" FOREIGN KEY ("admin_session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "staging_links" ADD CONSTRAINT "staging_links_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "staging_sessions" ADD CONSTRAINT "staging_sessions_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "staging_sessions" ADD CONSTRAINT "staging_sessions_admin_session_id_sessions_id_fkey" FOREIGN KEY ("admin_session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "staging_sessions" ADD CONSTRAINT "staging_sessions_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;