CREATE TABLE "media_quotas" (
	"workspace_id" uuid PRIMARY KEY,
	"quota_bytes" bigint NOT NULL,
	"warned_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "media_quotas_positive" CHECK ("quota_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "media_max_file_bytes" bigint;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "trashed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "trashed_by" uuid;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "focal_x" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "focal_y" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "failure" jsonb;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "media_site_id_trashed_at_index" ON "media" ("site_id","trashed_at");--> statement-breakpoint
CREATE INDEX "media_files_key_index" ON "media_files" ("key");--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_trashed_by_people_id_fkey" FOREIGN KEY ("trashed_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "media_quotas" ADD CONSTRAINT "media_quotas_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "media_quotas" ADD CONSTRAINT "media_quotas_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_focal_point_known" CHECK (("focal_x" is null and "focal_y" is null) or ("focal_x" between 0 and 100 and "focal_y" between 0 and 100));