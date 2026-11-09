CREATE TABLE "checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid,
	"content" jsonb NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"changed_by" uuid,
	"changed_via" jsonb,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_changes" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid,
	"part" text NOT NULL,
	"language" text,
	"person_id" uuid,
	"via" jsonb NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "draft_changes_part_unique" UNIQUE NULLS NOT DISTINCT("site_id","item_kind","item_id","part","language")
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid,
	"content" jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_by" uuid,
	"via" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_types" ADD COLUMN "revisions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "revisions_on" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "revision_days" integer;--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "revisions_kept" integer;--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "checkpoint_days" integer;--> statement-breakpoint
CREATE INDEX "checkpoints_site_id_item_idx" ON "checkpoints" ("site_id","item_kind","item_id","taken_at");--> statement-breakpoint
CREATE INDEX "revisions_site_id_item_idx" ON "revisions" ("site_id","item_kind","item_id","published_at");--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_changed_by_people_id_fkey" FOREIGN KEY ("changed_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "draft_changes" ADD CONSTRAINT "draft_changes_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "draft_changes" ADD CONSTRAINT "draft_changes_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_published_by_people_id_fkey" FOREIGN KEY ("published_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;