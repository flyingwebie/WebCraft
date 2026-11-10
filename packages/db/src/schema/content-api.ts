import { sql } from "drizzle-orm";
import {
	boolean,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites } from "./tenancy.ts";

/**
 * A Site's Content API settings (ADR 0029, GLOSSARY.md › Content API): whether it is on (off by
 * default) and what it leaves out. A Site table, made the first time Staff change them; until then
 * the Content API is off. Site settings: no Draft, applied at once.
 *
 * `hidden` holds what Staff hid, by id and Field path, so nothing hidden appears anywhere the API
 * answers: `{ postTypes: [<Post Type id>], fields: { <Post Type id>: ["summary", "address.city"] },
 * globals: ["phone"] }`. Everything else is exposed, Post Types and Fields added later included.
 */
export const contentApiSettings = pgTable(
	"content_api_settings",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		enabled: boolean("enabled").notNull().default(false),
		hidden: jsonb("hidden").notNull().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "content_api_settings_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("content_api_settings_site_id_unique").on(table.siteId),
	],
);

/**
 * Content keys (GLOSSARY.md › Content key): what a frontend built elsewhere sends to read one Site's
 * published content through the Content API. A key grants nothing else, so it may sit in browser
 * code; browsers on other sites may use it only from the origins it lists (`origins`, exact
 * `scheme://host[:port]` values, none by default).
 *
 * The key itself is shown once, when it is made; only a keyed hash of it is kept (`secret_hash`,
 * HMAC-SHA256 under a key derived from the Master key), with its last 4 characters (`hint`). Revoked
 * keys stay, so a frontend still holding one is told it was revoked.
 */
export const contentKeys = pgTable(
	"content_keys",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		name: text("name").notNull(),
		secretHash: text("secret_hash").notNull().unique(),
		hint: text("hint").notNull(),
		origins: text("origins").array().notNull().default(sql`'{}'::text[]`),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** Who made it; null once that person is deleted. */
		createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
		/** When a request last used it, at most once a minute. */
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "content_keys_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("content_keys_site_id_idx").on(table.siteId),
		unique("content_keys_id_site_id_unique").on(table.id, table.siteId),
	],
);

/**
 * How many requests each Content key made each day (UTC): one row per key and day it was used,
 * counted as requests come. A key's days older than 90 are deleted when it is first used on a new day.
 */
export const contentKeyUsage = pgTable(
	"content_key_usage",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		keyId: uuid("key_id").notNull(),
		day: date("day", { mode: "string" }).notNull(),
		requests: integer("requests").notNull().default(0),
	},
	(table) => [
		primaryKey({ columns: [table.keyId, table.day] }),
		foreignKey({
			name: "content_key_usage_key_fkey",
			columns: [table.keyId, table.siteId],
			foreignColumns: [contentKeys.id, contentKeys.siteId],
		}).onDelete("cascade"),
		foreignKey({
			name: "content_key_usage_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);
