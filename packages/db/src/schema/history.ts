import { foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites } from "./tenancy.ts";

// An item's history (`@webcraft/core` › history, GLOSSARY.md): Revisions, saved each time it is
// published, and Checkpoints, saved from its Draft while it is edited. Every publishable item has one:
// an Entry, the Globals, the Consent banner's words, a Form's emails, a Template, a Component, a Loop,
// a Filter, a script, a Form and the Design system. Site data like the content store: every row carries
// `workspace_id` and `site_id`, with a foreign key to `sites (workspace_id, id)`.
//
// An item is named as publishing names it: `item_kind` (`entry`, `template`, …) and `item_id`, null for
// the items a Site has one of (the Globals, the Consent banner's words, the Design system). Rows hold
// the item's whole version as its own table stores it (`entries.published`, a script's text), every
// language included, so a Site export can carry them as they are. Large versions are compressed by
// Postgres itself (TOAST); the `history.prune` job keeps them within the Install's retention.

/**
 * Revisions: the version an item was published with, each time it is published (one item on its
 * own, each item of Publish all, a Scheduled publish), with who published it, how they came in
 * (`via`, as the Audit log records it: the admin, an API token, an AI client) and when.
 */
export const revisions = pgTable(
	"revisions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		itemKind: text("item_kind").notNull(),
		itemId: uuid("item_id"),
		/** The whole published version, as the item's table stores it. */
		content: jsonb("content").notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
		/** Who published it; null when nobody did (a Module by itself) or they are gone. */
		publishedBy: uuid("published_by").references(() => people.id, { onDelete: "set null" }),
		/** How the publish came in (`AuditVia`). */
		via: jsonb("via").notNull(),
	},
	(table) => [
		foreignKey({
			name: "revisions_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("revisions_site_id_item_idx").on(table.siteId, table.itemKind, table.itemId, table.publishedAt),
	],
);

/**
 * Checkpoints: an item's Draft, saved while it is edited (`reason`): `activity` after 10 minutes of
 * changes, `left` when the last person editing it leaves, `restore` before a Revision or Checkpoint is
 * restored over it. Never saved when the Draft is what the newest Revision or Checkpoint holds.
 */
export const checkpoints = pgTable(
	"checkpoints",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		itemKind: text("item_kind").notNull(),
		itemId: uuid("item_id"),
		/** The whole Draft, as the item's table stores it. */
		content: jsonb("content").notNull(),
		takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
		reason: text("reason").notNull(),
		/** Who made the last change the Draft held; null when unknown, nobody (a Module) or gone. */
		changedBy: uuid("changed_by").references(() => people.id, { onDelete: "set null" }),
		/** How that change came in (`AuditVia`); null when unknown. */
		changedVia: jsonb("changed_via"),
		/** When the Draft it holds was last changed. */
		changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "checkpoints_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("checkpoints_site_id_item_idx").on(table.siteId, table.itemKind, table.itemId, table.takenAt),
	],
);

/**
 * Who last changed each part of an item's Draft, and when: one row per item, part (an Entry's Field
 * or built-in value by key, a Structure item's section) and language (null for a part kept once for
 * every language). Written with every Draft change; Compare reads it to say who changed what.
 */
export const draftChanges = pgTable(
	"draft_changes",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		itemKind: text("item_kind").notNull(),
		itemId: uuid("item_id"),
		part: text("part").notNull(),
		language: text("language"),
		/** Who changed it; null when nobody did (a Module) or they are gone. */
		personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
		/** How the change came in (`AuditVia`). */
		via: jsonb("via").notNull(),
		changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "draft_changes_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("draft_changes_part_unique")
			.on(table.siteId, table.itemKind, table.itemId, table.part, table.language)
			.nullsNotDistinct(),
	],
);
