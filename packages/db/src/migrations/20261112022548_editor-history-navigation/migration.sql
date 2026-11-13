CREATE TABLE "editor_history_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"person_id" uuid,
	"token_hash" text NOT NULL UNIQUE,
	"payload" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "editor_history_transfers_expires_idx" ON "editor_history_transfers" ("expires_at");--> statement-breakpoint
ALTER TABLE "editor_history_transfers" ADD CONSTRAINT "editor_history_transfers_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "editor_history_transfers" ADD CONSTRAINT "editor_history_transfers_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;