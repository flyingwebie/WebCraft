CREATE TABLE "ai_budgets" (
	"workspace_id" uuid,
	"key" text,
	"month" text,
	"spent" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	"notified" integer[] DEFAULT '{}'::integer[] NOT NULL,
	CONSTRAINT "ai_budgets_pkey" PRIMARY KEY("workspace_id","key","month")
);
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"key" text NOT NULL,
	"month" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"reserved_cost" bigint NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "install_ai_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"endpoint" text,
	"input_price" bigint,
	"output_price" bigint,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"tested_at" timestamp with time zone,
	"test_result" text
);
--> statement-breakpoint
CREATE TABLE "protected_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"term" text NOT NULL,
	"match_case" boolean NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "protected_terms_term_unique" UNIQUE NULLS NOT DISTINCT("workspace_id","site_id","term")
);
--> statement-breakpoint
CREATE TABLE "translation_cache" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"language" text,
	"glossary" text,
	"source_hash" text,
	"translation" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "translation_cache_pkey" PRIMARY KEY("site_id","language","glossary","source_hash")
);
--> statement-breakpoint
CREATE TABLE "translation_counts" (
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"month" text,
	"cached" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "translation_counts_pkey" PRIMARY KEY("site_id","month")
);
--> statement-breakpoint
CREATE TABLE "translation_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid,
	"language" text NOT NULL,
	"publish" boolean NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "translation_tasks_item_unique" UNIQUE NULLS NOT DISTINCT("site_id","item_kind","item_id","language")
);
--> statement-breakpoint
CREATE TABLE "workspace_ai" (
	"workspace_id" uuid PRIMARY KEY,
	"own_provider" text,
	"own_model" text,
	"own_endpoint" text,
	"own_input_price" bigint,
	"own_output_price" bigint,
	"own_cap" bigint,
	"own_set_by" uuid,
	"own_set_at" timestamp with time zone,
	"own_tested_at" timestamp with time zone,
	"own_test_result" text,
	"shared_key_id" uuid,
	"shared_cap" bigint,
	CONSTRAINT "workspace_ai_shared_has_cap" CHECK ("shared_key_id" is null or "shared_cap" is not null)
);
--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "emails_ai_translations" jsonb;--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "ai_private_endpoints" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_languages" ADD COLUMN "translation_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_calls_workspace_month_idx" ON "ai_calls" ("workspace_id","month");--> statement-breakpoint
CREATE INDEX "ai_calls_reserved_idx" ON "ai_calls" ("status","at");--> statement-breakpoint
CREATE INDEX "translation_tasks_status_idx" ON "translation_tasks" ("status");--> statement-breakpoint
ALTER TABLE "ai_budgets" ADD CONSTRAINT "ai_budgets_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "install_ai_keys" ADD CONSTRAINT "install_ai_keys_created_by_people_id_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "protected_terms" ADD CONSTRAINT "protected_terms_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "protected_terms" ADD CONSTRAINT "protected_terms_created_by_people_id_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "protected_terms" ADD CONSTRAINT "protected_terms_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "translation_cache" ADD CONSTRAINT "translation_cache_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "translation_counts" ADD CONSTRAINT "translation_counts_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "translation_tasks" ADD CONSTRAINT "translation_tasks_requested_by_people_id_fkey" FOREIGN KEY ("requested_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "translation_tasks" ADD CONSTRAINT "translation_tasks_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_ai" ADD CONSTRAINT "workspace_ai_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_ai" ADD CONSTRAINT "workspace_ai_own_set_by_people_id_fkey" FOREIGN KEY ("own_set_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_ai" ADD CONSTRAINT "workspace_ai_shared_key_id_install_ai_keys_id_fkey" FOREIGN KEY ("shared_key_id") REFERENCES "install_ai_keys"("id") ON DELETE SET NULL;