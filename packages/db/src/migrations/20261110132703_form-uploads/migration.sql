CREATE TABLE "form_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"submission_id" uuid,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"storage" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "form_uploads_site_submission_idx" ON "form_uploads" ("site_id","submission_id");--> statement-breakpoint
ALTER TABLE "form_uploads" ADD CONSTRAINT "form_uploads_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;