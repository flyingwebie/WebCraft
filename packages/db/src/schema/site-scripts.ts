import { foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { sites } from "./tenancy.ts";

// Site script safety (ADRs 0022, 0023): the hosts a Site's Content Security Policy allows, its
// outside scripts, its Libraries, and the script files a change replaced, kept for a while for pages
// loaded before it. Site tables: every row carries `workspace_id` and `site_id`, with a foreign key
// to `sites (workspace_id, id)`.

/**
 * The outside hosts a Site's Content Security Policy allows scripts (and what they load) from, beside
 * the Site's own domain. `source` says how a host got here: `hand` (Staff added it, such as a host a
 * tag manager loads from) or `auto` (an outside script needs it; removed with the last one that does).
 * Staff can remove either kind.
 */
export const allowedHosts = pgTable(
	"allowed_hosts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** A host name in lower case, or `*.` and a domain for every host under it. */
		host: text("host").notNull(),
		/** `hand` or `auto`. */
		source: text("source").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "allowed_hosts_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("allowed_hosts_site_id_host_unique").on(table.siteId, table.host),
	],
);

/**
 * A Site's outside scripts (ADR 0022): scripts loaded live from another host or pasted as a
 * third-party snippet. They never run in Edit mode. A pasted snippet is read into `parts` when it is
 * saved: each of its scripts either loads from another host (`src`) or is code of its own, which the
 * Site serves as a file named by its hash (never inline, ADR 0023).
 */
export const outsideScripts = pgTable(
	"outside_scripts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** What Staff call it, such as "Chat widget". */
		name: text("name").notNull(),
		/** `url` (one script address) or `snippet` (pasted). */
		kind: text("kind").notNull(),
		/** The script's address, for `url`; null for a snippet. */
		url: text("url"),
		/** The snippet as pasted, for `snippet`; null for a URL. */
		snippet: text("snippet"),
		/** What the page loads, in order (`OutsideScriptPart[]` in `@webcraft/core`). */
		parts: jsonb("parts").notNull(),
		/** `head` or `bodyEnd`. */
		placement: text("placement").notNull(),
		/** Its Consent category (`necessary`, `analytics`, `marketing`, `media`), for the Consent banner. */
		consentCategory: text("consent_category").notNull(),
		/** Its place in the Site's list: outside scripts load in this order. */
		position: integer("position").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "outside_scripts_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("outside_scripts_site_id_idx").on(table.siteId),
	],
);

/**
 * A Site's Libraries (ADR 0023): script packages kept at a fixed version, downloaded once from the
 * npm registry (`package`, `version`, `file`) or from an address (`url`), then stored in the Install's
 * storage and served from the Site's domain at `/_wc/lib/<hash>-<file name>`. They change only when
 * Staff update them.
 */
export const libraries = pgTable(
	"libraries",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** `npm` or `url`. */
		source: text("source").notNull(),
		/** The package's name, for `npm`. */
		packageName: text("package_name"),
		/** The exact version it holds, for `npm`. */
		version: text("version"),
		/** The file of the package it serves (`dist/library.min.js`), for `npm`. */
		file: text("file"),
		/** Where it was downloaded from, for `url`. */
		url: text("url"),
		/** The name it is served under after its hash: the file's own name. */
		fileName: text("file_name").notNull(),
		/** 16 hexadecimal digits of the file's SHA-256. */
		hash: text("hash").notNull(),
		/** The file's Subresource Integrity hash (`sha384-…`), which pages check it against. */
		integrity: text("integrity").notNull(),
		size: integer("size").notNull(),
		/** Which storage holds the file (`disk`, `s3`), and its key there. */
		storage: text("storage").notNull(),
		storageKey: text("storage_key").notNull(),
		/** The licence the package declares, as data; null when it declares none (or for `url`). */
		licence: text("licence"),
		/** The newest version the registry had when last checked, for `npm`. */
		latestVersion: text("latest_version"),
		checkedAt: timestamp("checked_at", { withTimezone: true }),
		/** Its place in the Site's list: Libraries load in this order, before the Site script. */
		position: integer("position").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "libraries_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("libraries_site_id_hash_idx").on(table.siteId, table.hash),
	],
);

/**
 * Script files a change stopped using: a Site script or page script a publish replaced, or the code
 * of an outside script's snippet that was changed or removed. Each is still served for 30 days under
 * its hashed name (`/_wc/js/<hash>.js`), so a page loaded just before still finds it.
 */
export const retiredScriptFiles = pgTable(
	"retired_script_files",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		hash: text("hash").notNull(),
		code: text("code").notNull(),
		retiredAt: timestamp("retired_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "retired_script_files_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("retired_script_files_site_id_hash_unique").on(table.siteId, table.hash),
		index("retired_script_files_retired_at_idx").on(table.retiredAt),
	],
);

/**
 * Library files an update or a removal stopped using: still served for 30 days under their name
 * (`/_wc/lib/<hash>-<file name>`), then removed from storage by `site-files.purge`.
 */
export const retiredLibraryFiles = pgTable(
	"retired_library_files",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The name it is served under: `<hash>-<file name>`. */
		name: text("name").notNull(),
		storage: text("storage").notNull(),
		storageKey: text("storage_key").notNull(),
		retiredAt: timestamp("retired_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "retired_library_files_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("retired_library_files_site_id_name_unique").on(table.siteId, table.name),
		index("retired_library_files_retired_at_idx").on(table.retiredAt),
	],
);
