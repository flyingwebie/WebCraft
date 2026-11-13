CREATE TABLE "impersonations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"session_id" uuid,
	"impersonator_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"workspace_ids" uuid[],
	"reason" text,
	"return_to" text,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text
);
--> statement-breakpoint
DROP INDEX "audit_log_workspace_id_occurred_at_idx";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "impersonator_id" uuid;--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "audit_retention_days" integer;--> statement-breakpoint
CREATE INDEX "audit_log_workspace_id_id_idx" ON "audit_log" ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_site_id_id_idx" ON "audit_log" ("site_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_person_id_id_idx" ON "audit_log" ("person_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_impersonator_id_id_idx" ON "audit_log" ("impersonator_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_action_id_idx" ON "audit_log" ("action","id");--> statement-breakpoint
CREATE UNIQUE INDEX "impersonations_one_per_session_idx" ON "impersonations" ("session_id") WHERE "ended_at" is null;--> statement-breakpoint
CREATE INDEX "impersonations_due_idx" ON "impersonations" ("ends_at") WHERE "ended_at" is null;--> statement-breakpoint
ALTER TABLE "impersonations" ADD CONSTRAINT "impersonations_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "impersonations" ADD CONSTRAINT "impersonations_impersonator_id_people_id_fkey" FOREIGN KEY ("impersonator_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "impersonations" ADD CONSTRAINT "impersonations_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;