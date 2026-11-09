CREATE TABLE "module_partition_settings" (
	"module_id" text,
	"table_name" text,
	"keep_months" integer NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"changed_by" uuid,
	CONSTRAINT "module_partition_settings_pkey" PRIMARY KEY("module_id","table_name")
);
--> statement-breakpoint
CREATE TABLE "visitor_salts" (
	"day" text PRIMARY KEY,
	"salt" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "module_partition_settings" ADD CONSTRAINT "module_partition_settings_changed_by_people_id_fkey" FOREIGN KEY ("changed_by") REFERENCES "people"("id") ON DELETE SET NULL;