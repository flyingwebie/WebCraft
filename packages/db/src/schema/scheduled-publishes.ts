import {
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

import { entries } from "./content.ts";
import { people } from "./people.ts";
import { sites } from "./tenancy.ts";

// Scheduled publishes (GLOSSARY.md › Scheduled publish): a publish set to happen at a later time, of
// one item or a Publish all set, holding each item's Draft as it was when it was scheduled; or an
// Entry's unpublish at a time. Site data like the content store: every row carries `workspace_id` and
// `site_id`, with a foreign key to `sites (workspace_id, id)`. A row exists only while it waits: the
// worker deletes it in the transaction that publishes it, and the Audit log keeps what happened.

/**
 * One Scheduled publish: what it does (`action`: `publish` or `unpublish`), whether it is one item's
 * or a Publish all set (`kind`: `item` or `set`), when (`at`, UTC), and who scheduled it, on whose
 * behalf the worker publishes. `attempts` counts runs Postgres itself gave up on (tried again the next
 * minute, a few times).
 */
export const scheduledPublishes = pgTable(
	"scheduled_publishes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		action: text("action").notNull(),
		kind: text("kind").notNull(),
		at: timestamp("at", { withTimezone: true }).notNull(),
		/** Who scheduled it; null once they are deleted (it then can't run, and fails). */
		createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
		/** How they came in (`AuditVia`). */
		createdVia: jsonb("created_via").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** Who last changed its time or took the current Drafts into it, and when. */
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		attempts: integer("attempts").notNull().default(0),
	},
	(table) => [
		foreignKey({
			name: "scheduled_publishes_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("scheduled_publishes_site_id_id_unique").on(table.siteId, table.id),
		index("scheduled_publishes_at_idx").on(table.at),
		index("scheduled_publishes_site_id_at_idx").on(table.siteId, table.at),
	],
);

/**
 * The items of a Scheduled publish, in the order they go live, each named as publishing names it
 * (`item_kind`, `item_id`: null for the items a Site has one of) with the version it publishes: its
 * Draft as its table stored it when it was scheduled (`content`, every language) and that Draft's
 * version (`version`, `draftVersion`), which "Changed since scheduled" compares the Draft with. An
 * unpublish holds neither. An item waits in at most one Scheduled publish of each action.
 */
export const scheduledPublishItems = pgTable(
	"scheduled_publish_items",
	{
		scheduleId: uuid("schedule_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		position: integer("position").notNull(),
		action: text("action").notNull(),
		itemKind: text("item_kind").notNull(),
		itemId: uuid("item_id"),
		content: jsonb("content"),
		version: text("version"),
	},
	(table) => [
		primaryKey({ name: "scheduled_publish_items_pkey", columns: [table.scheduleId, table.position] }),
		foreignKey({
			name: "scheduled_publish_items_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "scheduled_publish_items_schedule_fkey",
			columns: [table.siteId, table.scheduleId],
			foreignColumns: [scheduledPublishes.siteId, scheduledPublishes.id],
		}).onDelete("cascade"),
		unique("scheduled_publish_items_item_unique")
			.on(table.siteId, table.action, table.itemKind, table.itemId)
			.nullsNotDistinct(),
	],
);

/**
 * Where an unpublished Entry was: each path it had, in each language it was shown in (the path within
 * the language, without its prefix), so the Site answers 410 Gone there while nothing else is
 * published at it. Its rows go when the Entry is published again or deleted.
 */
export const gonePaths = pgTable(
	"gone_paths",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		entryId: uuid("entry_id").notNull(),
		language: text("language").notNull(),
		path: text("path").notNull(),
		goneAt: timestamp("gone_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ name: "gone_paths_pkey", columns: [table.siteId, table.language, table.path] }),
		foreignKey({
			name: "gone_paths_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "gone_paths_entry_fkey",
			columns: [table.siteId, table.entryId],
			foreignColumns: [entries.siteId, entries.id],
		}).onDelete("cascade"),
		index("gone_paths_entry_id_idx").on(table.entryId),
	],
);
