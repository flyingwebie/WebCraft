CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"post_type_id" uuid NOT NULL,
	"author_id" uuid,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone,
	CONSTRAINT "entries_site_id_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
CREATE TABLE "post_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"url_pattern" text NOT NULL,
	"fields" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "post_types_site_id_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "post_types_site_id_key_unique" UNIQUE("site_id","key"),
	CONSTRAINT "post_types_site_id_url_pattern_unique" UNIQUE("site_id","url_pattern")
);
--> statement-breakpoint
CREATE TABLE "published_slugs" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"entry_id" uuid,
	"post_type_id" uuid NOT NULL,
	"language" text,
	"slug" text NOT NULL,
	CONSTRAINT "published_slugs_pkey" PRIMARY KEY("entry_id","language"),
	CONSTRAINT "published_slugs_slug_unique" UNIQUE("site_id","post_type_id","language","slug")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"post_type_id" uuid,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone,
	CONSTRAINT "templates_site_id_kind_post_type_id_unique" UNIQUE NULLS NOT DISTINCT("site_id","kind","post_type_id")
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "default_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "page_cache_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "entries_site_id_post_type_id_idx" ON "entries" ("site_id","post_type_id");--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_author_id_people_id_fkey" FOREIGN KEY ("author_id") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_post_type_fkey" FOREIGN KEY ("site_id","post_type_id") REFERENCES "post_types"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "post_types" ADD CONSTRAINT "post_types_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "published_slugs" ADD CONSTRAINT "published_slugs_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "published_slugs" ADD CONSTRAINT "published_slugs_entry_fkey" FOREIGN KEY ("site_id","entry_id") REFERENCES "entries"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_post_type_fkey" FOREIGN KEY ("site_id","post_type_id") REFERENCES "post_types"("site_id","id") ON DELETE CASCADE;