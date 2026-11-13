CREATE TABLE "invite_sites" (
	"invite_id" uuid,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid,
	CONSTRAINT "invite_sites_pkey" PRIMARY KEY("invite_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "all_sites" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_id_workspace_id_unique" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_email_workspace_id_unique" UNIQUE("email","workspace_id");--> statement-breakpoint
CREATE INDEX "invites_workspace_id_idx" ON "invites" ("workspace_id");--> statement-breakpoint
ALTER TABLE "invite_sites" ADD CONSTRAINT "invite_sites_invite_fkey" FOREIGN KEY ("invite_id","workspace_id") REFERENCES "invites"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invite_sites" ADD CONSTRAINT "invite_sites_site_fkey" FOREIGN KEY ("workspace_id","site_id") REFERENCES "sites"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;