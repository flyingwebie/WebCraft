ALTER TABLE "import_files" ADD COLUMN "survey_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_files" ADD COLUMN "survey_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;