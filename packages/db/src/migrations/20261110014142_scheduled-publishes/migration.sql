CREATE TABLE "gone_paths" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"entry_id" uuid NOT NULL,
	"language" text,
	"path" text,
	"gone_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gone_paths_pkey" PRIMARY KEY("site_id","language","path")
);
--> statement-breakpoint
CREATE TABLE "scheduled_publish_items" (
	"schedule_id" uuid,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"position" integer,
	"action" text NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid,
	"name" text,
	"content" jsonb,
	"version" text,
	CONSTRAINT "scheduled_publish_items_pkey" PRIMARY KEY("schedule_id","position"),
	CONSTRAINT "scheduled_publish_items_item_unique" UNIQUE NULLS NOT DISTINCT("site_id","action","item_kind","item_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_publishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"action" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_via" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "scheduled_publishes_site_id_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "unpublished_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "gone_paths_entry_id_idx" ON "gone_paths" ("entry_id");--> statement-breakpoint
CREATE INDEX "scheduled_publishes_at_idx" ON "scheduled_publishes" ("at");--> statement-breakpoint
CREATE INDEX "scheduled_publishes_site_id_at_idx" ON "scheduled_publishes" ("site_id","at");--> statement-breakpoint
ALTER TABLE "gone_paths" ADD CONSTRAINT "gone_paths_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "gone_paths" ADD CONSTRAINT "gone_paths_entry_fkey" FOREIGN KEY ("site_id","entry_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scheduled_publish_items" ADD CONSTRAINT "scheduled_publish_items_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scheduled_publish_items" ADD CONSTRAINT "scheduled_publish_items_schedule_fkey" FOREIGN KEY ("site_id","schedule_id") REFERENCES "scheduled_publishes"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scheduled_publishes" ADD CONSTRAINT "scheduled_publishes_created_by_people_id_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "scheduled_publishes" ADD CONSTRAINT "scheduled_publishes_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "scheduled_publishes" ADD CONSTRAINT "scheduled_publishes_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;