CREATE TABLE "worker_heartbeats" (
	"id" uuid PRIMARY KEY,
	"hostname" text NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL
);
