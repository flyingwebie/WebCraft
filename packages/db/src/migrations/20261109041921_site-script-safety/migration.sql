CREATE TABLE "allowed_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"host" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "allowed_hosts_site_id_host_unique" UNIQUE("site_id","host")
);
--> statement-breakpoint
CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"source" text NOT NULL,
	"package_name" text,
	"version" text,
	"file" text,
	"url" text,
	"file_name" text NOT NULL,
	"hash" text NOT NULL,
	"integrity" text NOT NULL,
	"size" integer NOT NULL,
	"storage" text NOT NULL,
	"storage_key" text NOT NULL,
	"licence" text,
	"latest_version" text,
	"checked_at" timestamp with time zone,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outside_scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"snippet" text,
	"parts" jsonb NOT NULL,
	"placement" text NOT NULL,
	"consent_category" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retired_library_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"storage" text NOT NULL,
	"storage_key" text NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	CONSTRAINT "retired_library_files_site_id_name_unique" UNIQUE("site_id","name")
);
--> statement-breakpoint
CREATE TABLE "retired_script_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"code" text NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	CONSTRAINT "retired_script_files_site_id_hash_unique" UNIQUE("site_id","hash")
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "csp_mode" text DEFAULT 'strict' NOT NULL;--> statement-breakpoint
CREATE INDEX "libraries_site_id_hash_idx" ON "libraries" ("site_id","hash");--> statement-breakpoint
CREATE INDEX "outside_scripts_site_id_idx" ON "outside_scripts" ("site_id");--> statement-breakpoint
CREATE INDEX "retired_library_files_retired_at_idx" ON "retired_library_files" ("retired_at");--> statement-breakpoint
CREATE INDEX "retired_script_files_retired_at_idx" ON "retired_script_files" ("retired_at");--> statement-breakpoint
ALTER TABLE "allowed_hosts" ADD CONSTRAINT "allowed_hosts_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "libraries" ADD CONSTRAINT "libraries_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outside_scripts" ADD CONSTRAINT "outside_scripts_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "retired_library_files" ADD CONSTRAINT "retired_library_files_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "retired_script_files" ADD CONSTRAINT "retired_script_files_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;