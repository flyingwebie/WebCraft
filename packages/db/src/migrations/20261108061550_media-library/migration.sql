CREATE TABLE "install_storage" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"kind" text DEFAULT 'disk' NOT NULL,
	"s3_endpoint" text,
	"s3_region" text,
	"s3_bucket" text,
	"s3_prefix" text DEFAULT '' NOT NULL,
	"s3_path_style" boolean DEFAULT true NOT NULL,
	"s3_access_key_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "install_storage_single_row" CHECK ("id" = 1),
	CONSTRAINT "install_storage_kind_known" CHECK ("kind" in ('disk', 's3'))
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"folder_id" uuid,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"status" text NOT NULL,
	"texts" jsonb DEFAULT '{"values":{}}' NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_site_id_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "media_kind_known" CHECK ("kind" in ('image', 'document', 'video', 'audio')),
	CONSTRAINT "media_status_known" CHECK ("status" in ('processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"size_bytes" bigint NOT NULL,
	"storage" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_files_role_known" CHECK ("role" in ('upload', 'original', 'variant')),
	CONSTRAINT "media_files_storage_known" CHECK ("storage" in ('disk', 's3'))
);
--> statement-breakpoint
CREATE TABLE "media_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_folders_site_id_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
CREATE INDEX "media_site_id_created_at_index" ON "media" ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "media_files_site_id_name_index" ON "media_files" ("site_id","name");--> statement-breakpoint
CREATE INDEX "media_files_media_id_index" ON "media_files" ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_folders_site_id_name_unique" ON "media_folders" ("site_id",lower("name"));--> statement-breakpoint
ALTER TABLE "install_storage" ADD CONSTRAINT "install_storage_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_people_id_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_folder_fkey" FOREIGN KEY ("site_id","folder_id") REFERENCES "media_folders"("site_id","id");--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_media_fkey" FOREIGN KEY ("site_id","media_id") REFERENCES "media"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;