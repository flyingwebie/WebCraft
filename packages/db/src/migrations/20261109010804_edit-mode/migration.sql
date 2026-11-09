CREATE TABLE "edit_links" (
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
CREATE TABLE "edit_sessions" (
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
CREATE INDEX "edit_links_expires_at_idx" ON "edit_links" ("expires_at");--> statement-breakpoint
CREATE INDEX "edit_sessions_admin_session_id_idx" ON "edit_sessions" ("admin_session_id");--> statement-breakpoint
CREATE INDEX "edit_sessions_expires_at_idx" ON "edit_sessions" ("expires_at");--> statement-breakpoint
ALTER TABLE "edit_links" ADD CONSTRAINT "edit_links_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "edit_links" ADD CONSTRAINT "edit_links_admin_session_id_sessions_id_fkey" FOREIGN KEY ("admin_session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "edit_links" ADD CONSTRAINT "edit_links_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "edit_sessions" ADD CONSTRAINT "edit_sessions_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "edit_sessions" ADD CONSTRAINT "edit_sessions_admin_session_id_sessions_id_fkey" FOREIGN KEY ("admin_session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "edit_sessions" ADD CONSTRAINT "edit_sessions_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;