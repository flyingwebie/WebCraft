CREATE TABLE "content_api_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL CONSTRAINT "content_api_settings_site_id_unique" UNIQUE,
	"enabled" boolean DEFAULT false NOT NULL,
	"hidden" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_key_usage" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"key_id" uuid,
	"day" date,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "content_key_usage_pkey" PRIMARY KEY("key_id","day")
);
--> statement-breakpoint
CREATE TABLE "content_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL UNIQUE,
	"hint" text NOT NULL,
	"origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "content_keys_id_site_id_unique" UNIQUE("id","site_id")
);
--> statement-breakpoint
CREATE INDEX "content_keys_site_id_idx" ON "content_keys" ("site_id");--> statement-breakpoint
ALTER TABLE "content_api_settings" ADD CONSTRAINT "content_api_settings_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_key_usage" ADD CONSTRAINT "content_key_usage_key_fkey" FOREIGN KEY ("key_id","site_id") REFERENCES "content_keys"("id","site_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_key_usage" ADD CONSTRAINT "content_key_usage_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_keys" ADD CONSTRAINT "content_keys_created_by_people_id_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "content_keys" ADD CONSTRAINT "content_keys_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;