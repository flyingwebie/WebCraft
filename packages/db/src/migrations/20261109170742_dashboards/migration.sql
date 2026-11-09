CREATE TABLE "dashboard_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"range" jsonb NOT NULL,
	"widgets" jsonb NOT NULL,
	"made_from" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"range" jsonb NOT NULL,
	"shared_with_everyone" boolean DEFAULT false NOT NULL,
	"widgets" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "workspace_dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"range" jsonb NOT NULL,
	"shared_with_everyone" boolean DEFAULT false NOT NULL,
	"widgets" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "dashboard_templates_workspace_id_idx" ON "dashboard_templates" ("workspace_id");--> statement-breakpoint
CREATE INDEX "dashboards_site_id_idx" ON "dashboards" ("site_id");--> statement-breakpoint
CREATE INDEX "workspace_dashboards_workspace_id_idx" ON "workspace_dashboards" ("workspace_id");--> statement-breakpoint
ALTER TABLE "dashboard_templates" ADD CONSTRAINT "dashboard_templates_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "dashboard_templates" ADD CONSTRAINT "dashboard_templates_created_by_people_id_fkey" FOREIGN KEY ("created_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_dashboards" ADD CONSTRAINT "workspace_dashboards_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_dashboards" ADD CONSTRAINT "workspace_dashboards_updated_by_people_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "people"("id") ON DELETE SET NULL;