import { boolean, foreignKey, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites } from "./tenancy.ts";

// The Design system (ADR 0009): a Site's Design tokens, Classes, base styles and custom CSS. Site
// data, like the content store: every row carries `workspace_id` and `site_id`, with a foreign key
// to `sites (workspace_id, id)`.

/**
 * The Design system of a Site: one document holding its tokens, Classes, base styles, custom CSS
 * and dark mode setting (`@webcraft/renderer` › `DesignSystem`), with a Draft and a published version
 * like other publishable items, published as one item. Token and Class references inside it, and in
 * element trees, are ids, so renaming changes nothing stored elsewhere. Made the first time a Site
 * changes its Design system; until then, and until its first publish, the Site shows the default one.
 */
export const designSystems = pgTable(
	"design_systems",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The Draft: what Staff edit. */
		draft: jsonb("draft").notNull(),
		/** The published version visitors see; null until the first publish. */
		published: jsonb("published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** When the Draft was last saved. */
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		/** Who last changed the Draft (null when nobody did, or they are gone): what Publish all says. */
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "design_systems_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("design_systems_site_id_id_unique").on(table.siteId, table.id),
		unique("design_systems_site_id_unique").on(table.siteId),
	],
);

/**
 * Stylesheets a Site recently stopped using. A Site's current stylesheet is always built from what
 * it has published; when a publish changes it, the one it replaces is kept here for a while, so a
 * page a visitor loaded just before still finds its stylesheet under its content-hashed name.
 */
export const stylesheets = pgTable(
	"stylesheets",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The content hash in its file name. */
		hash: text("hash").notNull(),
		css: text("css").notNull(),
		/** When a publish replaced it. */
		retiredAt: timestamp("retired_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "stylesheets_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("stylesheets_site_id_hash_unique").on(table.siteId, table.hash),
	],
);

/**
 * No longer written: generated Classes made before the Design system had a Draft (#58). A migration
 * moved them into each Site's Design system; the table goes in a later release (ADR 0031).
 */
export const classes = pgTable(
	"classes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		name: text("name").notNull(),
		styles: text("styles").notNull().default(""),
		generated: boolean("generated").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "classes_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("classes_site_id_id_unique").on(table.siteId, table.id),
		unique("classes_site_id_name_unique").on(table.siteId, table.name),
	],
);
