CREATE TABLE "error_group_places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"group_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	"count" bigint NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "error_group_places_place_key" UNIQUE NULLS NOT DISTINCT("group_id","workspace_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "error_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"fingerprint" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"source_kind" text NOT NULL,
	"source_name" text,
	"request_id" text,
	"count" bigint NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"reopened_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "health_rows" (
	"part" text PRIMARY KEY,
	"status" text NOT NULL,
	"reason" jsonb DEFAULT '{}' NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"failing_since" timestamp with time zone,
	"clear_since" timestamp with time zone,
	"alerted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "error_groups_last_seen_at_idx" ON "error_groups" ("last_seen_at");--> statement-breakpoint
CREATE INDEX "error_groups_first_seen_at_idx" ON "error_groups" ("first_seen_at");--> statement-breakpoint
ALTER TABLE "error_group_places" ADD CONSTRAINT "error_group_places_group_id_error_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "error_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "error_group_places" ADD CONSTRAINT "error_group_places_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "error_group_places" ADD CONSTRAINT "error_group_places_site_id_sites_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_resolved_by_people_id_fkey" FOREIGN KEY ("resolved_by") REFERENCES "people"("id") ON DELETE SET NULL;