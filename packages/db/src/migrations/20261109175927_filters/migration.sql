CREATE TABLE "filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"loop" text NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone,
	CONSTRAINT "filters_site_id_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "filters_site_id_name_unique" UNIQUE("site_id","name"),
	CONSTRAINT "filters_site_id_loop_unique" UNIQUE("site_id","loop")
);
--> statement-breakpoint
ALTER TABLE "filters" ADD CONSTRAINT "filters_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "filters" ADD CONSTRAINT "filters_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;