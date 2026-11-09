CREATE TABLE "site_languages" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"code" text,
	"name" text NOT NULL,
	"direction" text NOT NULL,
	"domain" text CONSTRAINT "site_languages_domain_unique" UNIQUE,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "site_languages_pkey" PRIMARY KEY("site_id","code")
);
--> statement-breakpoint
ALTER TABLE "special_pages" DROP CONSTRAINT "special_pages_pkey";--> statement-breakpoint
ALTER TABLE "special_pages" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "browser_language_redirect" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "special_pages" ADD CONSTRAINT "special_pages_site_id_role_language_unique" UNIQUE NULLS NOT DISTINCT("site_id","role","language");--> statement-breakpoint
ALTER TABLE "site_languages" ADD CONSTRAINT "site_languages_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;