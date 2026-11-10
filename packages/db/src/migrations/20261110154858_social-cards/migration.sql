CREATE TABLE "social_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"language" text NOT NULL,
	"hash" text NOT NULL,
	"png" bytea NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "social_cards_input_unique" UNIQUE("site_id","entry_id","language","hash")
);
--> statement-breakpoint
ALTER TABLE "seo_settings" ADD COLUMN "social_cards_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_settings" ADD COLUMN "social_card_layout" text DEFAULT 'editorial' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_cards" ADD CONSTRAINT "social_cards_entry_id_entries_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "social_cards" ADD CONSTRAINT "social_cards_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;