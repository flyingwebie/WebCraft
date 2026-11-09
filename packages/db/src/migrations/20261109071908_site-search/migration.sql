CREATE TABLE "search_documents" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"entry_id" uuid,
	"language" text,
	"document" tsvector NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "search_documents_pkey" PRIMARY KEY("entry_id","language")
);
--> statement-breakpoint
ALTER TABLE "post_types" ADD COLUMN "searchable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "post_types" ADD COLUMN "searched_fields" jsonb DEFAULT '[{"field":"title","weight":"A"}]' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "search_index_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "search_documents_site_id_language_idx" ON "search_documents" ("site_id","language");--> statement-breakpoint
CREATE INDEX "search_documents_document_idx" ON "search_documents" USING gin ("document");--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_entry_fkey" FOREIGN KEY ("site_id","entry_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;