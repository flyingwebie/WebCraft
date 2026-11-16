ALTER TABLE "components" ADD COLUMN "page_id" uuid;--> statement-breakpoint
CREATE INDEX "components_page_id_idx" ON "components" ("page_id");--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_page_fkey" FOREIGN KEY ("site_id","page_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;