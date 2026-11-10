ALTER TABLE "post_types" ADD COLUMN "sitemap" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_settings" ADD COLUMN "ai_crawlers" text DEFAULT 'allowAll' NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_settings" ADD COLUMN "robots_lines" text DEFAULT '' NOT NULL;