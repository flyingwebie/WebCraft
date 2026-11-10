CREATE TABLE "install_report_branding" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"agency_name" text,
	"accent_colour" text,
	"agency_logo" bytea,
	"agency_logo_type" text,
	"show_agency" boolean DEFAULT true NOT NULL,
	"show_client" boolean DEFAULT true NOT NULL,
	"made_with" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "install_report_branding_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "report_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"report_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"previous_from" timestamp with time zone NOT NULL,
	"previous_to" timestamp with time zone NOT NULL,
	"language" text NOT NULL,
	"recipients" jsonb DEFAULT '[]' NOT NULL,
	"content" jsonb,
	"ai_status" text,
	"pdf" bytea,
	"pdf_bytes" integer,
	"render_attempts" integer DEFAULT 0 NOT NULL,
	"problem" text,
	"requested_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "report_sends_kind_known" CHECK ("kind" in ('scheduled', 'test')),
	CONSTRAINT "report_sends_status_known" CHECK ("status" in ('preparing', 'review', 'rendering', 'sent', 'failed', 'discarded'))
);
--> statement-breakpoint
CREATE TABLE "report_services" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"services" jsonb DEFAULT '[]' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "report_services_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"dashboard_id" uuid,
	"workspace_dashboard_id" uuid,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"language" text NOT NULL,
	"recipients" jsonb DEFAULT '[]' NOT NULL,
	"review" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "reports_one_dashboard" CHECK (("site_id" is not null and "dashboard_id" is not null and "workspace_dashboard_id" is null) or ("site_id" is null and "dashboard_id" is null and "workspace_dashboard_id" is not null)),
	CONSTRAINT "reports_schedule_known" CHECK ("schedule" in ('weekly', 'monthly'))
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"dashboard_id" uuid,
	"workspace_dashboard_id" uuid,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"token_hint" text NOT NULL,
	"password_hash" text,
	"password_changed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"opens" integer DEFAULT 0 NOT NULL,
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	CONSTRAINT "share_links_one_dashboard" CHECK (("site_id" is not null and "dashboard_id" is not null and "workspace_dashboard_id" is null) or ("site_id" is null and "dashboard_id" is null and "workspace_dashboard_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "site_report_branding" (
	"workspace_id" uuid,
	"site_id" uuid,
	"client_name" text,
	"client_logo" bytea,
	"client_logo_type" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "site_report_branding_pkey" PRIMARY KEY("workspace_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_report_branding" (
	"workspace_id" uuid PRIMARY KEY,
	"own_agency" boolean DEFAULT false NOT NULL,
	"agency_name" text,
	"accent_colour" text,
	"agency_logo" bytea,
	"agency_logo_type" text,
	"client_name" text,
	"client_logo" bytea,
	"client_logo_type" text,
	"show_agency" boolean,
	"show_client" boolean,
	"made_with" boolean,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "report_sends_report_id_created_at_idx" ON "report_sends" ("report_id","created_at");--> statement-breakpoint
CREATE INDEX "report_sends_created_at_idx" ON "report_sends" ("created_at");--> statement-breakpoint
CREATE INDEX "reports_workspace_id_idx" ON "reports" ("workspace_id");--> statement-breakpoint
CREATE INDEX "reports_dashboard_id_idx" ON "reports" ("dashboard_id");--> statement-breakpoint
CREATE INDEX "reports_workspace_dashboard_id_idx" ON "reports" ("workspace_dashboard_id");--> statement-breakpoint
CREATE INDEX "reports_next_run_at_idx" ON "reports" ("next_run_at");--> statement-breakpoint
CREATE INDEX "share_links_workspace_id_idx" ON "share_links" ("workspace_id");--> statement-breakpoint
CREATE INDEX "share_links_dashboard_id_idx" ON "share_links" ("dashboard_id");--> statement-breakpoint
CREATE INDEX "share_links_workspace_dashboard_id_idx" ON "share_links" ("workspace_dashboard_id");--> statement-breakpoint
ALTER TABLE "install_report_branding" ADD CONSTRAINT "install_report_branding_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_report_id_reports_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_requested_by_people_id_fkey" FOREIGN KEY ("requested_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_approved_by_people_id_fkey" FOREIGN KEY ("approved_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "report_services" ADD CONSTRAINT "report_services_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_dashboard_id_dashboards_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_workspace_dashboard_id_workspace_dashboards_id_fkey" FOREIGN KEY ("workspace_dashboard_id") REFERENCES "workspace_dashboards"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_people_id_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_dashboard_id_dashboards_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_workspace_dashboard_id_workspace_dashboards_id_fkey" FOREIGN KEY ("workspace_dashboard_id") REFERENCES "workspace_dashboards"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_people_id_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "site_report_branding" ADD CONSTRAINT "site_report_branding_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "site_report_branding" ADD CONSTRAINT "site_report_branding_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_report_branding" ADD CONSTRAINT "workspace_report_branding_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_report_branding" ADD CONSTRAINT "workspace_report_branding_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;