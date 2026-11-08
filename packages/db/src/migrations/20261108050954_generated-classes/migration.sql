CREATE TABLE "classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"styles" text DEFAULT '' NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "classes_site_id_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "classes_site_id_name_unique" UNIQUE("site_id","name")
);
--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;