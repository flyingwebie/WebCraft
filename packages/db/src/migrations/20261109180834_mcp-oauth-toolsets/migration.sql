CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"application_type" text NOT NULL,
	"auth_method" text NOT NULL,
	"secret_hash" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY,
	"grant_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_grant_sites" (
	"grant_id" uuid,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	CONSTRAINT "oauth_grant_sites_pkey" PRIMARY KEY("grant_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"client_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"all_sites" boolean DEFAULT true NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"may_publish" boolean DEFAULT false NOT NULL,
	"toolsets" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "oauth_grants_id_workspace_id_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"token_hash" text PRIMARY KEY,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "toolsets" text[] DEFAULT '{content,media,structure,forms,publishing,translation,siteSettings,analytics}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_banners" ADD COLUMN "updated_via" text;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "updated_via" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "updated_via" text;--> statement-breakpoint
ALTER TABLE "globals" ADD COLUMN "updated_via" text;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "updated_via" text;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "updated_via" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "updated_via" text;--> statement-breakpoint
ALTER TABLE "design_systems" ADD COLUMN "updated_via" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "emails_updated_via" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "updated_via" text;--> statement-breakpoint
CREATE INDEX "oauth_codes_grant_id_idx" ON "oauth_codes" ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_person_id_idx" ON "oauth_grants" ("person_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_workspace_id_idx" ON "oauth_grants" ("workspace_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_client_id_idx" ON "oauth_grants" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_id_idx" ON "oauth_tokens" ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_expires_at_idx" ON "oauth_tokens" ("expires_at");--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_grant_id_oauth_grants_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "oauth_grants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_grant_sites" ADD CONSTRAINT "oauth_grant_sites_grant_fkey" FOREIGN KEY ("grant_id","workspace_id") REFERENCES "oauth_grants"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_grant_sites" ADD CONSTRAINT "oauth_grant_sites_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "oauth_grants"("id") ON DELETE CASCADE;