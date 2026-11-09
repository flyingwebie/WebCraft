CREATE TABLE "draft_document_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "draft_document_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"update" bytea NOT NULL,
	"person_id" uuid,
	"via" jsonb,
	"made_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid,
	"state" bytea NOT NULL,
	"state_through" bigint DEFAULT 0 NOT NULL,
	"draft" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "draft_documents_item_unique" UNIQUE NULLS NOT DISTINCT("site_id","item_kind","item_id")
);
--> statement-breakpoint
CREATE INDEX "draft_document_changes_document_idx" ON "draft_document_changes" ("document_id","id");--> statement-breakpoint
ALTER TABLE "draft_document_changes" ADD CONSTRAINT "draft_document_changes_document_id_draft_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "draft_documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "draft_document_changes" ADD CONSTRAINT "draft_document_changes_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "draft_document_changes" ADD CONSTRAINT "draft_document_changes_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "draft_documents" ADD CONSTRAINT "draft_documents_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;