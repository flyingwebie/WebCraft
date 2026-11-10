/**
 * The parts of an Install that Install health looks at (`GLOSSARY.md`), in the order the screen
 * lists them, and what each can be. Imports nothing, so the admin and the email catalogue read it.
 */
export const HEALTH_PARTS = [
	"web",
	"worker",
	"database",
	"jobQueue",
	"storage",
	"backups",
	"smtp",
	"domains",
	"errorLog",
	"moduleLog",
] as const;

export type HealthPart = (typeof HEALTH_PARTS)[number];

/** OK, Warning or Failing: only Failing sends a Health alert. */
export const HEALTH_STATUSES = ["ok", "warning", "failing"] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/**
 * Why a part is Failing, as Health alert emails word it (the screen words every reason, these and the
 * others, from the admin's messages):
 * - worker: `stale` (no check-in for over 2 minutes), `never` (none ever);
 * - database: `behind` (migrations to run), `jobQueueNewer` (a newer version's job queue), `unreachable`;
 * - jobQueue: `stuck` (jobs due long ago that nothing picks up, or running far past their time);
 * - storage: `unwritable` (the write test failed), `full` (almost no space left);
 * - backups: `failed` (the last one failed), `overdue` (none done for two days);
 * - smtp: `failing` (the Install SMTP's last 3 sends failed);
 * - domains: `unreachable` (a live domain the Install should answer doesn't, or its certificate).
 */
export const FAILING_REASONS = [
	"stale",
	"never",
	"behind",
	"jobQueueNewer",
	"unreachable",
	"stuck",
	"unwritable",
	"full",
	"failed",
	"overdue",
	"failing",
] as const;

export type FailingReason = (typeof FAILING_REASONS)[number];

/** Where the Install health screen is, which the banner and the alerts link to. */
export const INSTALL_HEALTH_PATH = "/install/health";
