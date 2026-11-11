ALTER TABLE "scripts" DROP CONSTRAINT "scripts_site_id_kind_entry_id_unique";--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "component_id" uuid;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "consent_category" text;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "library_ids" uuid[];--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "published_consent_category" text;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "published_library_ids" uuid[];--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_site_id_kind_entry_id_component_id_unique" UNIQUE NULLS NOT DISTINCT("site_id","kind","entry_id","component_id");--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_component_fkey" FOREIGN KEY ("site_id","component_id") REFERENCES "components"("site_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_component_kind_check" CHECK (("kind" = 'component') = ("component_id" is not null));