ALTER TABLE "media_folders" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "media_folder_order" text DEFAULT 'name' NOT NULL;