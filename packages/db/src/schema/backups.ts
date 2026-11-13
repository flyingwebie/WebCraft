import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";

/**
 * The WebCraft versions whose migrate step ran on the database, each with when it last did. The
 * newest is the version the data was written by: a Backup records it, and a restore refuses a
 * Backup whose data a newer version wrote.
 */
export const installVersions = pgTable("install_versions", {
	version: text("version").primaryKey(),
	migratedAt: timestamp("migrated_at", { withTimezone: true }).notNull(),
});

/**
 * Install settings › Backups: one row, with id 1, written the first time it changes. Until then
 * scheduled Backups are on, to the Backups folder (`WEBCRAFT_BACKUP_DIR`).
 */
export const backupSettings = pgTable(
	"backup_settings",
	{
		id: integer("id").primaryKey().default(1),
		/** Whether the worker takes a Backup every day (keeping 7 daily and 4 weekly). */
		scheduled: boolean("scheduled").notNull().default(true),
		/** Where Backups go: `folder` (the Backups folder) or `s3` (an S3-compatible bucket). */
		target: text("target").notNull().default("folder"),
		/** The bucket, once one was set; kept when Backups go back to the folder. The secret access key is the Install secret `backups.s3.secretAccessKey`. */
		s3Endpoint: text("s3_endpoint"),
		s3Region: text("s3_region"),
		s3Bucket: text("s3_bucket"),
		s3Prefix: text("s3_prefix").notNull().default(""),
		s3PathStyle: boolean("s3_path_style").notNull().default(true),
		s3AccessKeyId: text("s3_access_key_id"),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		check("backup_settings_single_row", sql`${table.id} = 1`),
		check("backup_settings_target_known", sql`${table.target} in ('folder', 's3')`),
	],
);

/**
 * Every Backup the Install took or tried, for Install settings › Backups and the Install's health:
 * why it was taken, where it went, how it ended. A failed one says why (never a secret). The
 * scheduled ones the keep rules removed say when.
 */
export const backups = pgTable(
	"backups",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** `scheduled` (the daily Backup), `command` (`webcraft admin backup`) or `before-migrations`. */
		reason: text("reason").notNull(),
		/** `folder`, `s3` or `file` (a path given to `webcraft admin backup --to`). */
		target: text("target").notNull(),
		/** The archive's file name, `webcraft-backup-<time>-<reason>.tar`. */
		name: text("name").notNull(),
		/** Where it was written: the folder or file path, or `s3://<bucket>/<key>`. */
		location: text("location").notNull(),
		/** `running`, `done` or `failed`. */
		status: text("status").notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		sizeBytes: bigint("size_bytes", { mode: "number" }),
		/** Why it failed, in a sentence. */
		problem: text("problem"),
		/** When the keep rules removed a scheduled Backup's archive. */
		removedAt: timestamp("removed_at", { withTimezone: true }),
	},
	(table) => [
		index("backups_started_at_index").on(table.startedAt),
		check("backups_reason_known", sql`${table.reason} in ('scheduled', 'command', 'before-migrations')`),
		check("backups_target_known", sql`${table.target} in ('folder', 's3', 'file')`),
		check("backups_status_known", sql`${table.status} in ('running', 'done', 'failed')`),
	],
);

/**
 * The last check of the release feed for a newer WebCraft (one row, id 1): the newest release it
 * found, or why it couldn't read the feed. The worker checks at most once a day; the admin's
 * "Update available" notice reads this row and never calls out itself.
 */
export const updateChecks = pgTable(
	"update_checks",
	{
		id: integer("id").primaryKey().default(1),
		checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
		/** The newest release the feed listed, when the check read it. */
		latestVersion: text("latest_version"),
		releaseUrl: text("release_url"),
		/** The release notes, as plain text (at most 4,000 characters). */
		notes: text("notes"),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		/** Why the last check failed (`unreachable`, `status`, `format`, …); null when it read the feed. */
		problem: text("problem"),
	},
	(table) => [check("update_checks_single_row", sql`${table.id} = 1`)],
);
