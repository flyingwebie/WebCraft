CREATE TABLE "scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entry_id" uuid,
	"draft" text NOT NULL,
	"draft_hash" text NOT NULL,
	"published" text,
	"published_hash" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone,
	CONSTRAINT "scripts_site_id_kind_entry_id_unique" UNIQUE NULLS NOT DISTINCT("site_id","kind","entry_id")
);
--> statement-breakpoint
CREATE INDEX "scripts_site_id_published_hash_idx" ON "scripts" ("site_id","published_hash");--> statement-breakpoint
CREATE INDEX "scripts_site_id_draft_hash_idx" ON "scripts" ("site_id","draft_hash");--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_entry_fkey" FOREIGN KEY ("site_id","entry_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;