ALTER TABLE "dashboards" ADD COLUMN "built_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboards_built_in_site_idx" ON "dashboards" ("site_id") WHERE "built_in";