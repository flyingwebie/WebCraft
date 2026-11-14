CREATE TABLE "check_sightings" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"key" text,
	"item_kind" text NOT NULL,
	"item_id" text NOT NULL,
	"language" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "check_sightings_pkey" PRIMARY KEY("site_id","key")
);
--> statement-breakpoint
CREATE INDEX "check_sightings_item_idx" ON "check_sightings" ("site_id","item_kind","item_id");--> statement-breakpoint
ALTER TABLE "check_sightings" ADD CONSTRAINT "check_sightings_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;