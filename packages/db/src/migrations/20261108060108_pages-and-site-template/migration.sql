CREATE TABLE "special_pages" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"role" text,
	"entry_id" uuid NOT NULL,
	CONSTRAINT "special_pages_pkey" PRIMARY KEY("site_id","role")
);
--> statement-breakpoint
ALTER TABLE "post_types" ADD COLUMN "built_in" text;--> statement-breakpoint
ALTER TABLE "published_slugs" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "post_types" ADD CONSTRAINT "post_types_site_id_built_in_unique" UNIQUE("site_id","built_in");--> statement-breakpoint
ALTER TABLE "published_slugs" DROP CONSTRAINT "published_slugs_slug_unique";--> statement-breakpoint
ALTER TABLE "published_slugs" ADD CONSTRAINT "published_slugs_slug_unique" UNIQUE NULLS NOT DISTINCT("site_id","post_type_id","language","parent_id","slug");--> statement-breakpoint
ALTER TABLE "published_slugs" ADD CONSTRAINT "published_slugs_parent_fkey" FOREIGN KEY ("site_id","parent_id") REFERENCES "entries"("site_id","id");--> statement-breakpoint
ALTER TABLE "special_pages" ADD CONSTRAINT "special_pages_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "special_pages" ADD CONSTRAINT "special_pages_entry_fkey" FOREIGN KEY ("site_id","entry_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;