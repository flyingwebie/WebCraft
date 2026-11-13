CREATE TABLE "paused_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"language" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"status" text NOT NULL,
	"requested_by" uuid,
	"with_secrets" boolean NOT NULL,
	"with_submissions" boolean DEFAULT true NOT NULL,
	"kdf" jsonb,
	"storage" text NOT NULL,
	"key" text NOT NULL,
	"parts" jsonb DEFAULT '[]' NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" bigint,
	"progress" jsonb,
	"summary" jsonb,
	"failure" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "site_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_by" uuid,
	"file_name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"part_bytes" integer NOT NULL,
	"parts" jsonb DEFAULT '[]' NOT NULL,
	"storage" text NOT NULL,
	"key" text NOT NULL,
	"manifest" jsonb,
	"refusal" jsonb,
	"name" text,
	"slug" text,
	"site_id" uuid,
	"progress" jsonb,
	"report" jsonb,
	"failure" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "paused_domains_site_id_idx" ON "paused_domains" ("site_id");--> statement-breakpoint
CREATE INDEX "site_exports_site_id_idx" ON "site_exports" ("site_id");--> statement-breakpoint
CREATE INDEX "site_exports_expires_at_idx" ON "site_exports" ("expires_at");--> statement-breakpoint
CREATE INDEX "site_imports_workspace_id_idx" ON "site_imports" ("workspace_id");--> statement-breakpoint
CREATE INDEX "site_imports_expires_at_idx" ON "site_imports" ("expires_at");--> statement-breakpoint
ALTER TABLE "paused_domains" ADD CONSTRAINT "paused_domains_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "site_exports" ADD CONSTRAINT "site_exports_requested_by_people_id_fkey" FOREIGN KEY ("requested_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "site_exports" ADD CONSTRAINT "site_exports_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "site_imports" ADD CONSTRAINT "site_imports_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "site_imports" ADD CONSTRAINT "site_imports_started_by_people_id_fkey" FOREIGN KEY ("started_by") REFERENCES "people"("id") ON DELETE SET NULL;