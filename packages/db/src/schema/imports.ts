import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { entries } from "./content.ts";
import { media } from "./media.ts";
import { people } from "./people.ts";
import { sites } from "./tenancy.ts";

// Imports (GLOSSARY.md › Importing): bringing outside content into one Site as Drafts. One pipeline
// for every source: a source reads items as a stream, a mapping turns them into Entries, a run writes
// them as Drafts with their Source id, and its Import report records what happened. Site tables:
// every row carries `workspace_id` and `site_id`, with a foreign key to `sites (workspace_id, id)`.

/**
 * An Import: a saved way of bringing one source's content into the Site (its kind, such as `csv`)
 * and how it maps onto a Post Type and its Fields (`settings`, as the source reads it). It can be
 * run more than once.
 */
export const imports = pgTable(
	"imports",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** Shown in the Import list and the reports. */
		name: text("name").notNull(),
		/** The kind of source: `csv` (later the WordPress import's kinds). */
		source: text("source").notNull(),
		/** The source's settings and mapping, as its kind reads them. */
		settings: jsonb("settings").notNull(),
		/** How many runs it has had: the next run's number is one more, even after reports are purged. */
		runs: integer("runs").notNull().default(0),
		createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "imports_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("imports_site_id_id_unique").on(table.siteId, table.id),
		index("imports_site_id_idx").on(table.siteId),
	],
);

/**
 * A file uploaded for an Import, such as a CSV file. It is private: never in the Media library and
 * never served, kept apart in the Site's storage folder (`…/imports/<id>`), read by the worker as a
 * stream, and deleted once the run that took it ends (or a day after it was uploaded, if no run did).
 */
export const importFiles = pgTable(
	"import_files",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** Who uploaded it: only they may use it. */
		uploadedBy: uuid("uploaded_by").references(() => people.id, { onDelete: "cascade" }),
		fileName: text("file_name").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		/** Which storage holds it (`disk`, `s3`), and its key there. */
		storage: text("storage").notNull(),
		key: text("key").notNull(),
		/** What reading it found: its columns and first row, how many rows, its separator. */
		details: jsonb("details").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** When it is deleted if no run took it. */
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "import_files_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("import_files_site_id_idx").on(table.siteId),
		index("import_files_expires_at_idx").on(table.expiresAt),
	],
);

/**
 * An Import run: one run of an Import, in the background. Its progress (`done` of `total`), its
 * counts and status are its Import report, with its changes and problems; the report is kept 90 days
 * after the run ends (`expires_at`), then purged.
 */
export const importRuns = pgTable(
	"import_runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		importId: uuid("import_id").notNull(),
		/** 1 for the Import's first run, then 2, 3, … */
		number: integer("number").notNull(),
		/** `waiting`, `running`, `stopped`, `done`, `failed` or `undone`. */
		status: text("status").notNull(),
		startedBy: uuid("started_by").references(() => people.id, { onDelete: "set null" }),
		/** The settings the run used, as they were when it started. */
		settings: jsonb("settings").notNull(),
		/** The file it reads; null once it was deleted (when the run ends). */
		fileId: uuid("file_id").references(() => importFiles.id, { onDelete: "set null" }),
		fileName: text("file_name").notNull(),
		/** Items the source holds, and how many the run has gone through. */
		total: integer("total").notNull(),
		done: integer("done").notNull().default(0),
		/**
		 * What the run did so far: how many items it created, updated, left unchanged and skipped, how
		 * many had problems, and which columns of the source it skipped.
		 */
		summary: jsonb("summary").notNull(),
		/** Why a failed run stopped. */
		failure: jsonb("failure"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		/** When someone asked it to stop: it finishes the item it is on, keeping what's done. */
		stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		undoneAt: timestamp("undone_at", { withTimezone: true }),
		undoneBy: uuid("undone_by").references(() => people.id, { onDelete: "set null" }),
		/** When the report is purged: 90 days after the run ended. */
		expiresAt: timestamp("expires_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "import_runs_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "import_runs_import_fkey",
			columns: [table.siteId, table.importId],
			foreignColumns: [imports.siteId, imports.id],
		}).onDelete("cascade"),
		unique("import_runs_import_id_number_unique").on(table.importId, table.number),
		unique("import_runs_site_id_id_unique").on(table.siteId, table.id),
		index("import_runs_expires_at_idx").on(table.expiresAt),
		check(
			"import_runs_status_known",
			sql`${table.status} in ('waiting', 'running', 'stopped', 'done', 'failed', 'undone')`,
		),
	],
);

/**
 * What an Import brought in, by Source id: the identifier an item had in the place it came from (a
 * CSV row's matching value), so a later run updates it instead of making a copy. Kept as long as
 * the Import and the Entry (or Media item) are, with what the last run wrote, so a run can tell
 * whether anyone touched it since.
 */
export const importItems = pgTable(
	"import_items",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		importId: uuid("import_id").notNull(),
		/** `entry` or `media` (later Redirect rules). */
		kind: text("kind").notNull(),
		sourceId: text("source_id").notNull(),
		entryId: uuid("entry_id").references(() => entries.id, { onDelete: "cascade" }),
		mediaId: uuid("media_id").references(() => media.id, { onDelete: "cascade" }),
		/** The Draft the last run left (a hash) and when it saved it: anything else since is someone's edit. */
		writtenHash: text("written_hash"),
		writtenAt: timestamp("written_at", { withTimezone: true }),
		lastRunId: uuid("last_run_id").references(() => importRuns.id, { onDelete: "set null" }),
	},
	(table) => [
		foreignKey({
			name: "import_items_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "import_items_import_fkey",
			columns: [table.siteId, table.importId],
			foreignColumns: [imports.siteId, imports.id],
		}).onDelete("cascade"),
		unique("import_items_import_id_kind_source_id_unique").on(table.importId, table.kind, table.sourceId),
		index("import_items_entry_id_idx").on(table.entryId),
		index("import_items_media_id_idx").on(table.mediaId),
		check("import_items_kind_known", sql`${table.kind} in ('entry', 'media')`),
	],
);

/**
 * What one run did with each item it went through: created, updated (with the Draft as it was
 * before, so Undo can put it back), left unchanged, or skipped (someone edited it since an earlier
 * run). Undo checks each Entry is still as the run left it. Purged with the run's report.
 */
export const importRunChanges = pgTable(
	"import_run_changes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		runId: uuid("run_id").notNull(),
		/** Where the item was in the source: a CSV file's row number. */
		position: integer("position").notNull(),
		kind: text("kind").notNull(),
		/** `created`, `updated`, `unchanged` or `skipped`. */
		action: text("action").notNull(),
		/** Why it was skipped: `edited` (someone changed it since an earlier run). */
		reason: text("reason"),
		entryId: uuid("entry_id").references(() => entries.id, { onDelete: "set null" }),
		mediaId: uuid("media_id").references(() => media.id, { onDelete: "set null" }),
		/** An updated Entry's Draft before the run changed it. */
		before: jsonb("before"),
		/** The Draft the run left (a hash), when it saved it, and when the Entry was last published then. */
		writtenHash: text("written_hash"),
		writtenAt: timestamp("written_at", { withTimezone: true }),
		publishedThen: timestamp("published_then", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "import_run_changes_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "import_run_changes_run_fkey",
			columns: [table.siteId, table.runId],
			foreignColumns: [importRuns.siteId, importRuns.id],
		}).onDelete("cascade"),
		index("import_run_changes_run_id_position_idx").on(table.runId, table.position),
		check("import_run_changes_kind_known", sql`${table.kind} in ('entry', 'media')`),
		check("import_run_changes_action_known", sql`${table.action} in ('created', 'updated', 'unchanged', 'skipped')`),
	],
);

/**
 * The problems a run found, each at its row and column (null for the whole row) with its rule: a
 * value a Field can't take, a file that couldn't be fetched, a row matching several Entries. Purged
 * with the run's report.
 */
export const importRunProblems = pgTable(
	"import_run_problems",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		runId: uuid("run_id").notNull(),
		position: integer("position").notNull(),
		/** Its place among the item's problems, in the order they were found. */
		ordinal: integer("ordinal").notNull(),
		column: text("column"),
		rule: text("rule").notNull(),
		/** What fills in the rule's wording, such as the row it repeats or why a file wasn't fetched. */
		params: jsonb("params"),
	},
	(table) => [
		foreignKey({
			name: "import_run_problems_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "import_run_problems_run_fkey",
			columns: [table.siteId, table.runId],
			foreignColumns: [importRuns.siteId, importRuns.id],
		}).onDelete("cascade"),
		index("import_run_problems_run_id_position_idx").on(table.runId, table.position),
	],
);
