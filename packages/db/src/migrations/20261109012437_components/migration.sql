CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone,
	CONSTRAINT "components_site_id_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "components_site_id_name_unique" UNIQUE("site_id","name")
);
--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;