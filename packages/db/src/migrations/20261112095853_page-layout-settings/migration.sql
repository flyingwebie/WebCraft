CREATE TABLE "page_layout_settings" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid PRIMARY KEY,
	"enabled" boolean DEFAULT false NOT NULL,
	"allowed_components" jsonb DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_layout_settings" ADD CONSTRAINT "page_layout_settings_QfXBO8O7r76f_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;