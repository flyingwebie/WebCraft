CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone NOT NULL,
	"person_id" uuid,
	"via" text NOT NULL,
	"via_name" text,
	"workspace_id" uuid,
	"site_id" uuid,
	"action" text NOT NULL,
	"details" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_workspaces" (
	"invite_id" uuid,
	"workspace_id" uuid,
	CONSTRAINT "invite_workspaces_pkey" PRIMARY KEY("invite_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"role" text NOT NULL,
	"all_workspaces" boolean DEFAULT false NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_sites" (
	"membership_id" uuid,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	CONSTRAINT "membership_sites_pkey" PRIMARY KEY("membership_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"all_sites" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memberships_workspace_id_person_id_unique" UNIQUE("workspace_id","person_id"),
	CONSTRAINT "memberships_id_workspace_id_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sites_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "staff_workspaces" (
	"person_id" uuid,
	"workspace_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "staff_workspaces_pkey" PRIMARY KEY("person_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "install_roles" ADD COLUMN "all_workspaces" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "workspace_id" SET DATA TYPE uuid USING "workspace_id"::uuid;--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "site_id" SET DATA TYPE uuid USING "site_id"::uuid;--> statement-breakpoint
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log" ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_workspace_id_occurred_at_idx" ON "audit_log" ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "invites_email_idx" ON "invites" ("email");--> statement-breakpoint
CREATE INDEX "memberships_person_id_idx" ON "memberships" ("person_id");--> statement-breakpoint
CREATE INDEX "staff_workspaces_workspace_id_idx" ON "staff_workspaces" ("workspace_id");--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invite_workspaces" ADD CONSTRAINT "invite_workspaces_invite_id_invites_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "invites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invite_workspaces" ADD CONSTRAINT "invite_workspaces_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_people_id_fkey" FOREIGN KEY ("invited_by") REFERENCES "people"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "membership_sites" ADD CONSTRAINT "membership_sites_membership_fkey" FOREIGN KEY ("membership_id","workspace_id") REFERENCES "memberships"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "membership_sites" ADD CONSTRAINT "membership_sites_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "staff_workspaces" ADD CONSTRAINT "staff_workspaces_person_id_install_roles_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "install_roles"("person_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "staff_workspaces" ADD CONSTRAINT "staff_workspaces_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;