ALTER TABLE "reviews" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
CREATE INDEX "reviews_schedule_id_idx" ON "reviews" ("schedule_id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_schedule_fkey" FOREIGN KEY ("schedule_id") REFERENCES "scheduled_publishes"("id") ON DELETE SET NULL;