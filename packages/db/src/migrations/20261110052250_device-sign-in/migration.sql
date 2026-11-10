CREATE TABLE "oauth_device_codes" (
	"device_code_hash" text PRIMARY KEY,
	"user_code_hash" text NOT NULL UNIQUE,
	"client_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"interval_seconds" integer NOT NULL,
	"last_polled_at" timestamp with time zone,
	"status" text NOT NULL,
	"grant_id" uuid
);
--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "grant_types" text[];--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "resource" text;--> statement-breakpoint
CREATE INDEX "oauth_device_codes_expires_at_idx" ON "oauth_device_codes" ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_device_codes_client_id_idx" ON "oauth_device_codes" ("client_id");--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_client_id_oauth_clients_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_grant_id_oauth_grants_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "oauth_grants"("id") ON DELETE CASCADE;