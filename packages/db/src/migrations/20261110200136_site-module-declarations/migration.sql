CREATE TABLE "site_module_components" (
	"workspace_id" uuid,
	"site_id" uuid,
	"component_id" text,
	"module_id" text NOT NULL,
	"module_version" text NOT NULL,
	"props" jsonb NOT NULL,
	CONSTRAINT "site_module_components_pkey" PRIMARY KEY("workspace_id","site_id","component_id")
);
--> statement-breakpoint
CREATE INDEX "site_module_components_site_id_idx" ON "site_module_components" ("site_id");--> statement-breakpoint
ALTER TABLE "site_module_components" ADD CONSTRAINT "site_module_components_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;