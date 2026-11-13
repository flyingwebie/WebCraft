CREATE TABLE "accessibility_statements" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid PRIMARY KEY,
	"page_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"forms" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accessibility_statements" ADD CONSTRAINT "accessibility_statements_C1RdOsQKMe6Y_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "accessibility_statements" ADD CONSTRAINT "accessibility_statements_umNqLtOfnm10_fkey" FOREIGN KEY ("site_id","page_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "accessibility_statements" ADD CONSTRAINT "accessibility_statements_Jjn1SJaejBh2_fkey" FOREIGN KEY ("site_id","component_id") REFERENCES "components"("site_id","id") ON DELETE CASCADE;