CREATE TABLE "confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"preview" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_links" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"entry_id" uuid,
	"version" text,
	"field" text,
	"target_id" uuid,
	CONSTRAINT "entry_links_pkey" PRIMARY KEY("entry_id","version","field","target_id")
);
--> statement-breakpoint
CREATE TABLE "globals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL CONSTRAINT "globals_site_id_unique" UNIQUE,
	"fields" jsonb DEFAULT '[]' NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "entry_links_site_id_target_id_idx" ON "entry_links" ("site_id","target_id");--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_entry_fkey" FOREIGN KEY ("site_id","entry_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_target_fkey" FOREIGN KEY ("site_id","target_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "globals" ADD CONSTRAINT "globals_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;