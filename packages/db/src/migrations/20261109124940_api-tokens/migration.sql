CREATE TABLE "api_token_sites" (
	"token_id" uuid,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	CONSTRAINT "api_token_sites_pkey" PRIMARY KEY("token_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"person_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL UNIQUE,
	"hint" text NOT NULL,
	"all_sites" boolean DEFAULT true NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "api_tokens_id_workspace_id_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE INDEX "api_tokens_person_id_idx" ON "api_tokens" ("person_id");--> statement-breakpoint
CREATE INDEX "api_tokens_workspace_id_idx" ON "api_tokens" ("workspace_id");--> statement-breakpoint
ALTER TABLE "api_token_sites" ADD CONSTRAINT "api_token_sites_token_fkey" FOREIGN KEY ("token_id","workspace_id") REFERENCES "api_tokens"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_token_sites" ADD CONSTRAINT "api_token_sites_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;