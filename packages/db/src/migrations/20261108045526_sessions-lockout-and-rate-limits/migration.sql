CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY,
	"hits" integer NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "leaked_password_check" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "identity_checked_at" timestamp with time zone;