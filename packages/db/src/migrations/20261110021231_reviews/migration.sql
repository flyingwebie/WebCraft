CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"entry_id" uuid,
	"status" text NOT NULL,
	"submitted_by" uuid,
	"submitted_via" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"note" text,
	"version" text NOT NULL,
	"decided_by" uuid,
	"decided_via" jsonb,
	"decided_at" timestamp with time zone,
	"comment" text,
	"scheduled_at" timestamp with time zone,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_one_waiting" ON "reviews" ("site_id","item_kind",coalesce(entry_id::text, '')) WHERE status = 'inReview';--> statement-breakpoint
CREATE INDEX "reviews_site_id_status_idx" ON "reviews" ("site_id","status","submitted_at");--> statement-breakpoint
CREATE INDEX "reviews_site_id_item_idx" ON "reviews" ("site_id","item_kind","entry_id","submitted_at");--> statement-breakpoint
CREATE INDEX "reviews_entry_id_idx" ON "reviews" ("entry_id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_submitted_by_people_id_fkey" FOREIGN KEY ("submitted_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_decided_by_people_id_fkey" FOREIGN KEY ("decided_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_entry_fkey" FOREIGN KEY ("site_id","entry_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;