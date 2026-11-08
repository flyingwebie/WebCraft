CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY,
	"hits" integer NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL
);
