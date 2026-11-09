ALTER TABLE "import_items" DROP CONSTRAINT "import_items_import_id_kind_source_id_unique";--> statement-breakpoint
ALTER TABLE "import_files" ADD COLUMN "source" text DEFAULT 'csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_files" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_files" ADD COLUMN "received_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_files" ADD COLUMN "part_bytes" integer;--> statement-breakpoint
ALTER TABLE "import_files" ADD COLUMN "parts" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_files" ADD COLUMN "preview" jsonb;--> statement-breakpoint
ALTER TABLE "import_items" ADD COLUMN "post_type_id" uuid;--> statement-breakpoint
ALTER TABLE "import_run_changes" ADD COLUMN "post_type_id" uuid;--> statement-breakpoint
ALTER TABLE "import_run_changes" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "import_run_changes" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_import_id_kind_post_type_id_source_id_unique" UNIQUE NULLS NOT DISTINCT("import_id","kind","post_type_id","source_id");--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_post_type_id_post_types_id_fkey" FOREIGN KEY ("post_type_id") REFERENCES "post_types"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_run_changes" ADD CONSTRAINT "import_run_changes_post_type_id_post_types_id_fkey" FOREIGN KEY ("post_type_id") REFERENCES "post_types"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_status_known" CHECK ("status" in ('uploading', 'surveying', 'ready', 'refused'));--> statement-breakpoint
ALTER TABLE "import_run_changes" DROP CONSTRAINT "import_run_changes_kind_known", ADD CONSTRAINT "import_run_changes_kind_known" CHECK ("kind" in ('entry', 'media', 'postType', 'field', 'redirect'));