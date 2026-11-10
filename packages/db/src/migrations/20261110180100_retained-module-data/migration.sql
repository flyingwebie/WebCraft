CREATE TABLE "site_retained_rows" (
	"workspace_id" uuid,
	"site_id" uuid,
	"table_name" text,
	"position" bigint,
	"value" jsonb NOT NULL,
	CONSTRAINT "site_retained_rows_pkey" PRIMARY KEY("workspace_id","site_id","table_name","position")
);
--> statement-breakpoint
CREATE TABLE "site_retained_tables" (
	"workspace_id" uuid,
	"site_id" uuid,
	"table_name" text,
	"module_id" text NOT NULL,
	"module_version" text NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "site_retained_tables_pkey" PRIMARY KEY("workspace_id","site_id","table_name")
);
--> statement-breakpoint
CREATE INDEX "site_retained_rows_site_id_idx" ON "site_retained_rows" ("site_id");--> statement-breakpoint
CREATE INDEX "site_retained_tables_site_id_idx" ON "site_retained_tables" ("site_id");--> statement-breakpoint
ALTER TABLE "site_retained_rows" ADD CONSTRAINT "site_retained_rows_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "site_retained_rows" ADD CONSTRAINT "site_retained_rows_table_fkey" FOREIGN KEY ("workspace_id","site_id","table_name") REFERENCES "site_retained_tables"("workspace_id","site_id","table_name") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "site_retained_tables" ADD CONSTRAINT "site_retained_tables_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;