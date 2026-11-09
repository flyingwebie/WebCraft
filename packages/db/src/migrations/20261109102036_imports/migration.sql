CREATE TABLE "import_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"file_name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage" text NOT NULL,
	"key" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"entry_id" uuid,
	"media_id" uuid,
	"written_hash" text,
	"written_at" timestamp with time zone,
	"last_run_id" uuid,
	CONSTRAINT "import_items_import_id_kind_source_id_unique" UNIQUE("import_id","kind","source_id"),
	CONSTRAINT "import_items_kind_known" CHECK ("kind" in ('entry', 'media'))
);
--> statement-breakpoint
CREATE TABLE "import_run_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"entry_id" uuid,
	"media_id" uuid,
	"before" jsonb,
	"written_hash" text,
	"written_at" timestamp with time zone,
	"published_then" timestamp with time zone,
	CONSTRAINT "import_run_changes_kind_known" CHECK ("kind" in ('entry', 'media')),
	CONSTRAINT "import_run_changes_action_known" CHECK ("action" in ('created', 'updated', 'unchanged', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "import_run_problems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"column" text,
	"rule" text NOT NULL,
	"params" jsonb
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text NOT NULL,
	"started_by" uuid,
	"settings" jsonb NOT NULL,
	"file_id" uuid,
	"file_name" text NOT NULL,
	"total" integer NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"summary" jsonb NOT NULL,
	"failure" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"stop_requested_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"expires_at" timestamp with time zone,
	CONSTRAINT "import_runs_import_id_number_unique" UNIQUE("import_id","number"),
	CONSTRAINT "import_runs_site_id_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "import_runs_status_known" CHECK ("status" in ('waiting', 'running', 'stopped', 'done', 'failed', 'undone'))
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"settings" jsonb NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "imports_site_id_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
CREATE INDEX "import_files_site_id_idx" ON "import_files" ("site_id");--> statement-breakpoint
CREATE INDEX "import_files_expires_at_idx" ON "import_files" ("expires_at");--> statement-breakpoint
CREATE INDEX "import_items_entry_id_idx" ON "import_items" ("entry_id");--> statement-breakpoint
CREATE INDEX "import_items_media_id_idx" ON "import_items" ("media_id");--> statement-breakpoint
CREATE INDEX "import_run_changes_run_id_position_idx" ON "import_run_changes" ("run_id","position");--> statement-breakpoint
CREATE INDEX "import_run_problems_run_id_position_idx" ON "import_run_problems" ("run_id","position");--> statement-breakpoint
CREATE INDEX "import_runs_expires_at_idx" ON "import_runs" ("expires_at");--> statement-breakpoint
CREATE INDEX "imports_site_id_idx" ON "imports" ("site_id");--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_uploaded_by_people_id_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_entry_id_entries_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_media_id_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_last_run_id_import_runs_id_fkey" FOREIGN KEY ("last_run_id") REFERENCES "import_runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_import_fkey" FOREIGN KEY ("site_id","import_id") REFERENCES "imports"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_run_changes" ADD CONSTRAINT "import_run_changes_entry_id_entries_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "import_run_changes" ADD CONSTRAINT "import_run_changes_media_id_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "import_run_changes" ADD CONSTRAINT "import_run_changes_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_run_changes" ADD CONSTRAINT "import_run_changes_run_fkey" FOREIGN KEY ("site_id","run_id") REFERENCES "import_runs"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_run_problems" ADD CONSTRAINT "import_run_problems_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_run_problems" ADD CONSTRAINT "import_run_problems_run_fkey" FOREIGN KEY ("site_id","run_id") REFERENCES "import_runs"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_started_by_people_id_fkey" FOREIGN KEY ("started_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_file_id_import_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "import_files"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_undone_by_people_id_fkey" FOREIGN KEY ("undone_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_import_fkey" FOREIGN KEY ("site_id","import_id") REFERENCES "imports"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_people_id_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;