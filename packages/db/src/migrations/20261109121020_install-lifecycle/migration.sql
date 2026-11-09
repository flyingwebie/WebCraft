CREATE TABLE "backup_settings" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"scheduled" boolean DEFAULT true NOT NULL,
	"target" text DEFAULT 'folder' NOT NULL,
	"s3_endpoint" text,
	"s3_region" text,
	"s3_bucket" text,
	"s3_prefix" text DEFAULT '' NOT NULL,
	"s3_path_style" boolean DEFAULT true NOT NULL,
	"s3_access_key_id" text,
	"updated_at" timestamp with time zone,
	"updated_by" uuid,
	CONSTRAINT "backup_settings_single_row" CHECK ("id" = 1),
	CONSTRAINT "backup_settings_target_known" CHECK ("target" in ('folder', 's3'))
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"reason" text NOT NULL,
	"target" text NOT NULL,
	"name" text NOT NULL,
	"location" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"size_bytes" bigint,
	"problem" text,
	"removed_at" timestamp with time zone,
	CONSTRAINT "backups_reason_known" CHECK ("reason" in ('scheduled', 'command', 'before-migrations')),
	CONSTRAINT "backups_target_known" CHECK ("target" in ('folder', 's3', 'file')),
	CONSTRAINT "backups_status_known" CHECK ("status" in ('running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "install_versions" (
	"version" text PRIMARY KEY,
	"migrated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "update_checks" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"checked_at" timestamp with time zone NOT NULL,
	"latest_version" text,
	"release_url" text,
	"notes" text,
	"published_at" timestamp with time zone,
	"problem" text,
	CONSTRAINT "update_checks_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE INDEX "backups_started_at_index" ON "backups" ("started_at");--> statement-breakpoint
ALTER TABLE "backup_settings" ADD CONSTRAINT "backup_settings_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;