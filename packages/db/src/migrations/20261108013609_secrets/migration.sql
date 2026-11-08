CREATE TABLE "master_key_versions" (
	"version" integer PRIMARY KEY,
	"fingerprint" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" text,
	"site_id" text,
	"name" text NOT NULL,
	"key_version" integer NOT NULL,
	"iv" bytea NOT NULL,
	"ciphertext" bytea NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secrets_owner_name_unique" UNIQUE NULLS NOT DISTINCT("workspace_id","site_id","name"),
	CONSTRAINT "secrets_site_has_workspace" CHECK ("site_id" is null or "workspace_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_key_version_master_key_versions_version_fkey" FOREIGN KEY ("key_version") REFERENCES "master_key_versions"("version");