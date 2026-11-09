import {
	boolean,
	index,
	integer,
	moduleSchema,
	siteColumns,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "@webcraft/module-sdk";

const schema = moduleSchema("redirects");

/**
 * A Site's Redirect rules: from a Site path (or every path under one, `wildcard`) to a Site path or
 * an `https://` address, with a 301 or a 302. `automatic` rules are the ones the Module added when a
 * published path changed: they step aside where a page is published at their path again.
 */
export const rules = schema.table(
	"rules",
	{
		...siteColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		/** The Site path it matches, canonical, without the trailing `/*` of a wildcard rule. */
		fromPath: text("from_path").notNull(),
		/** Whether it matches every path under `fromPath` too (written `/old/*`). */
		wildcard: boolean("wildcard").notNull(),
		/** Where it sends visitors: a Site path or an `https://` address, ending `/*` to carry the rest over. */
		target: text("target").notNull(),
		/** 301 or 302. */
		status: integer("status").notNull(),
		automatic: boolean("automatic").notNull(),
		/** For an automatic rule, the Entry whose published path changed. */
		entryId: uuid("entry_id"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		uniqueIndex("rules_site_from_unique").on(table.siteId, table.fromPath, table.wildcard),
		index("rules_site_target_idx").on(table.siteId, table.target),
		index("rules_site_updated_at_idx").on(table.siteId, table.updatedAt),
	],
);

/**
 * The 404 log: each Site path visitors asked for that had no page, with how often, when first and
 * last, and the host of the last page that linked there. Kept bounded: the most recently seen
 * `MAX_LOGGED_PATHS` paths per Site, each for `LOG_KEPT_DAYS` after it was last seen.
 */
export const misses = schema.table(
	"misses",
	{
		...siteColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		path: text("path").notNull(),
		language: text("language").notNull(),
		hits: integer("hits").notNull(),
		firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
		lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
		referrerHost: text("referrer_host"),
		/** Ignored paths stay out of the log's list (and keep being counted), until someone shows them again. */
		ignored: boolean("ignored").notNull(),
	},
	(table) => [
		uniqueIndex("misses_site_path_unique").on(table.siteId, table.path),
		index("misses_site_last_seen_idx").on(table.siteId, table.lastSeen),
	],
);
