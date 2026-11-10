CREATE TABLE "popups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"component_id" uuid NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"content_draft" jsonb NOT NULL,
	"content_published" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	"updated_via" text,
	"content_updated_at" timestamp with time zone NOT NULL,
	"content_updated_by" uuid,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone,
	"content_updated_via" text,
	"content_published_at" timestamp with time zone,
	CONSTRAINT "popups_site_key_unique" UNIQUE("site_id","key"),
	CONSTRAINT "popups_site_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "popup_id" uuid;--> statement-breakpoint
DROP INDEX "reviews_one_waiting";--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_one_waiting" ON "reviews" ("site_id","item_kind",coalesce(entry_id::text, popup_id::text, '')) WHERE status = 'inReview';--> statement-breakpoint
ALTER TABLE "popups" ADD CONSTRAINT "popups_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "popups" ADD CONSTRAINT "popups_content_updated_by_people_id_fkey" FOREIGN KEY ("content_updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "popups" ADD CONSTRAINT "popups_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "popups" ADD CONSTRAINT "popups_component_fkey" FOREIGN KEY ("site_id","component_id") REFERENCES "components"("site_id","id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_popup_fkey" FOREIGN KEY ("site_id","popup_id") REFERENCES "popups"("site_id","id") ON DELETE CASCADE;