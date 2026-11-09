CREATE TABLE "design_systems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL CONSTRAINT "design_systems_site_id_unique" UNIQUE,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone,
	CONSTRAINT "design_systems_site_id_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
CREATE TABLE "stylesheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"css" text NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stylesheets_site_id_hash_unique" UNIQUE("site_id","hash")
);
--> statement-breakpoint
ALTER TABLE "design_systems" ADD CONSTRAINT "design_systems_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stylesheets" ADD CONSTRAINT "stylesheets_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;