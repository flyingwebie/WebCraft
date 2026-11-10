import {
	bigint,
	boolean,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

// Site exports and Site imports (ADR 0033, GLOSSARY.md › Site export, Site import): moving or copying
// one Site between Installs as one archive. An export is a Site table (it belongs to the Site it was
// taken of); an import is a Workspace table, since its Site doesn't exist until it has run.

/**
 * One Site export: the archive the worker writes of the Site, kept as parts in the Site's private
 * storage folder (`<workspace id>/<site id>/exports/<id>/part-000001`, …), never served but through
 * its signed download link, and deleted once that link expires (24 hours after it was written).
 */
export const siteExports = pgTable(
	"site_exports",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** `waiting`, `running`, `done`, `failed`, or `expired` once its file is deleted. */
		status: text("status").notNull(),
		/** Who asked for it: the job writes as them, with their access checked again. */
		requestedBy: uuid("requested_by").references(() => people.id, { onDelete: "set null" }),
		/** Whether the Site's secrets go in, encrypted under the export passphrase (never stored). */
		withSecrets: boolean("with_secrets").notNull(),
		/** The passphrase's key derivation: its salt and rounds (not secret; the archive carries them too). */
		kdf: jsonb("kdf"),
		/** Which storage holds the archive's parts (`disk`, `s3`), and their folder there. */
		storage: text("storage").notNull(),
		key: text("key").notNull(),
		/** Each part's SHA-256, in hexadecimal, in order. */
		parts: jsonb("parts").notNull().default([]),
		fileName: text("file_name").notNull(),
		sizeBytes: bigint("size_bytes", { mode: "number" }),
		/** How far the job got: `{ step, done, total }`. */
		progress: jsonb("progress"),
		/** What went in and what was left out: counts, secrets carried or dropped, what never moves. */
		summary: jsonb("summary"),
		/** Why it failed: `{ reason }` (`access`, `error`). */
		failure: jsonb("failure"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		/** Until when its download link works; its file is deleted then. */
		expiresAt: timestamp("expires_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "site_exports_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("site_exports_site_id_idx").on(table.siteId),
		index("site_exports_expires_at_idx").on(table.expiresAt),
	],
);

/**
 * One Site import: a Site export uploaded in parts into a Workspace (kept privately under
 * `<workspace id>/site-imports/<id>/part-000001`, …), then read by the worker into a new Site. Its
 * Site import report says what was reassigned, dropped, paused and invited.
 */
export const siteImports = pgTable(
	"site_imports",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		/**
		 * `uploading` (parts still coming), `ready` (whole and read: waiting to be started), `refused`
		 * (not an export WebCraft takes), `waiting` and `running` (the worker's), `done` or `failed`.
		 */
		status: text("status").notNull(),
		/** Who uploaded it and started it: the job writes as them, with their access checked again. */
		startedBy: uuid("started_by").references(() => people.id, { onDelete: "set null" }),
		fileName: text("file_name").notNull(),
		sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
		receivedBytes: bigint("received_bytes", { mode: "number" }).notNull().default(0),
		partBytes: integer("part_bytes").notNull(),
		/** Each part's SHA-256, in hexadecimal, in order. */
		parts: jsonb("parts").notNull().default([]),
		storage: text("storage").notNull(),
		key: text("key").notNull(),
		/** What the archive's manifest says, once it came whole: the Site, versions, counts, Modules, secrets. */
		manifest: jsonb("manifest"),
		/** Why the archive was refused: `{ reason, … }`. */
		refusal: jsonb("refusal"),
		/** The new Site's name and slug, chosen when the import was started. */
		name: text("name"),
		slug: text("slug"),
		/** The Site it made (no foreign key: the report outlives a Site deleted later). */
		siteId: uuid("site_id"),
		/** How far the job got: `{ step, done, total }`. */
		progress: jsonb("progress"),
		/** The Site import report. */
		report: jsonb("report"),
		/** Why it failed: `{ reason }`. */
		failure: jsonb("failure"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		/** Until when the upload (before it runs) or the report (after) is kept. */
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		index("site_imports_workspace_id_idx").on(table.workspaceId),
		index("site_imports_expires_at_idx").on(table.expiresAt),
	],
);

/**
 * A Paused domain (GLOSSARY.md): a domain a Site import brought, kept off the Site's domain list until
 * Staff switch it on, when it is added (and verified) like any domain. Its name may still be another
 * Site's on the same Install, so it isn't unique here.
 */
export const pausedDomains = pgTable(
	"paused_domains",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		name: text("name").notNull(),
		/** What it was on the Site it came from: `primary`, `redirect` or `language`. */
		role: text("role").notNull(),
		/** A language's domain: the language's code. */
		language: text("language"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "paused_domains_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("paused_domains_site_id_idx").on(table.siteId),
	],
);
