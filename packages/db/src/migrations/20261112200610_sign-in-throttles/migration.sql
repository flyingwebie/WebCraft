CREATE TABLE "sign_in_throttles" (
	"person_id" uuid,
	"origin" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"known_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sign_in_throttles_pkey" PRIMARY KEY("person_id","origin")
);
--> statement-breakpoint
CREATE INDEX "sign_in_throttles_updated_at_idx" ON "sign_in_throttles" ("updated_at");--> statement-breakpoint
ALTER TABLE "sign_in_throttles" ADD CONSTRAINT "sign_in_throttles_person_id_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE;