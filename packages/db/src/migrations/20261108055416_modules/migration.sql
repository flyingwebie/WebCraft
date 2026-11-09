CREATE TABLE "module_approvals" (
	"module_id" text PRIMARY KEY,
	"version" text NOT NULL,
	"granted" jsonb NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"approved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "module_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "module_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"module_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"workspace_id" uuid,
	"site_id" uuid,
	"details" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_migrations" (
	"module_id" text,
	"name" text,
	"checksum" text NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	CONSTRAINT "module_migrations_pkey" PRIMARY KEY("module_id","name")
);
--> statement-breakpoint
CREATE TABLE "module_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"module_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"on" boolean NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"changed_by" uuid,
	CONSTRAINT "module_switches_place_unique" UNIQUE NULLS NOT DISTINCT("module_id","workspace_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "confirmations" ALTER COLUMN "site_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "module_log_module_id_occurred_at_idx" ON "module_log" ("module_id","occurred_at");--> statement-breakpoint
CREATE INDEX "module_log_occurred_at_idx" ON "module_log" ("occurred_at");--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "module_approvals" ADD CONSTRAINT "module_approvals_approved_by_people_id_fkey" FOREIGN KEY ("approved_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "module_switches" ADD CONSTRAINT "module_switches_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "module_switches" ADD CONSTRAINT "module_switches_changed_by_people_id_fkey" FOREIGN KEY ("changed_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "module_switches" ADD CONSTRAINT "module_switches_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;