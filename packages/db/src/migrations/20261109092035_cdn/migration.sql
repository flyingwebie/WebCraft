CREATE TABLE "cdn_ranges" (
	"cdn" text PRIMARY KEY,
	"ranges" text[] NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "cdn" text;