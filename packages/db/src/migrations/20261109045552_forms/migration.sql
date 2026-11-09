CREATE TABLE "form_settings" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid PRIMARY KEY,
	"captcha" jsonb,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone,
	CONSTRAINT "forms_site_id_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "forms_site_id_key_unique" UNIQUE("site_id","key")
);
--> statement-breakpoint
ALTER TABLE "form_settings" ADD CONSTRAINT "form_settings_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;