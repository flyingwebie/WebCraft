import { sql } from "drizzle-orm";
import { foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites } from "./tenancy.ts";

// The content store (`@webcraft/core` › content). Every table here is Site data: it carries
// `workspace_id` and `site_id`, with a foreign key to `sites (workspace_id, id)`, so a row can never
// point at another Workspace's Site, and the data layer limits every query to one Site.
//
// Publishable items keep two versions side by side: `draft` (what people edit) and `published`
// (what visitors see, null until the first publish). Publishing copies the Draft over the published
// version. Translatable values are stored per Field and per language inside each version (ADR 0003).

/**
 * Post Types: the kinds of Entry a Site holds, with their URL pattern and Fields. Post Types are
 * Structure without a Draft: changes apply at once. Every Site has the built-in Page Post Type
 * (`built_in = 'page'`), made with the Site.
 */
export const postTypes = pgTable(
	"post_types",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** Names the Post Type in Template markup, the APIs and files, such as `blog`. Unique on the Site. */
		key: text("key").notNull(),
		name: text("name").notNull(),
		/** Where its Entries are, such as `/blog/{slug}`. Unique on the Site. */
		urlPattern: text("url_pattern").notNull(),
		/** The Fields, in order: a JSON list of Field definitions. */
		fields: jsonb("fields").notNull().default(sql`'[]'::jsonb`),
		/**
		 * Which built-in Post Type this is: `page` for the Page Post Type (its URL pattern is `/{path}`:
		 * each Page's path is its parent Page's path and its own slug); null for one Staff made.
		 */
		builtIn: text("built_in"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "post_types_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("post_types_site_id_id_unique").on(table.siteId, table.id),
		unique("post_types_site_id_key_unique").on(table.siteId, table.key),
		unique("post_types_site_id_url_pattern_unique").on(table.siteId, table.urlPattern),
		unique("post_types_site_id_built_in_unique").on(table.siteId, table.builtIn),
	],
);

/**
 * Entries: one record of a Post Type. Built-in values (title, slug) and Field values live in the
 * version documents, per Field and per language; the dates and the author are columns.
 */
export const entries = pgTable(
	"entries",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		postTypeId: uuid("post_type_id").notNull(),
		/** Who created the Entry; null once that person is deleted. */
		authorId: uuid("author_id").references(() => people.id, { onDelete: "set null" }),
		/** The Draft: what people edit. */
		draft: jsonb("draft").notNull(),
		/** The published version visitors see; null until the first publish. */
		published: jsonb("published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** When the Draft was last saved. */
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		/** When the Entry was first published. */
		publishedAt: timestamp("published_at", { withTimezone: true }),
		/** When the Entry was last published. */
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "entries_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "entries_post_type_fkey",
			columns: [table.siteId, table.postTypeId],
			foreignColumns: [postTypes.siteId, postTypes.id],
		}).onDelete("cascade"),
		unique("entries_site_id_id_unique").on(table.siteId, table.id),
		index("entries_site_id_post_type_id_idx").on(table.siteId, table.postTypeId),
	],
);

/**
 * The published slug of each Entry in each language, so the Site request pipeline finds an Entry
 * by URL with one indexed lookup, and two published Entries of a Post Type never share a slug.
 * A Page also keeps its published parent Page: two Pages share a slug only under different parents,
 * and a Page's path is found one parent at a time. Written by publish.
 */
export const publishedSlugs = pgTable(
	"published_slugs",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		entryId: uuid("entry_id").notNull(),
		postTypeId: uuid("post_type_id").notNull(),
		language: text("language").notNull(),
		slug: text("slug").notNull(),
		/** A Page's published parent Page; null for a top-level Page and for every other Entry. */
		parentId: uuid("parent_id"),
	},
	(table) => [
		primaryKey({ columns: [table.entryId, table.language] }),
		foreignKey({
			name: "published_slugs_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "published_slugs_entry_fkey",
			columns: [table.siteId, table.entryId],
			foreignColumns: [entries.siteId, entries.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "published_slugs_parent_fkey",
			columns: [table.siteId, table.parentId],
			foreignColumns: [entries.siteId, entries.id],
		}),
		unique("published_slugs_slug_unique")
			.on(table.siteId, table.postTypeId, table.language, table.parentId, table.slug)
			.nullsNotDistinct(),
	],
);

/**
 * Templates, stored as element trees (ADR 0002): a Draft and a published version each. `kind` is
 * `entry` for an Entry template, one per Post Type; the Site template and Archive templates join it.
 */
export const templates = pgTable(
	"templates",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		kind: text("kind").notNull(),
		/** The Post Type an Entry or Archive template belongs to; null for the Site template. */
		postTypeId: uuid("post_type_id"),
		/** The Draft element tree. */
		draft: jsonb("draft").notNull(),
		/** The published element tree; null until the first publish. */
		published: jsonb("published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "templates_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "templates_post_type_fkey",
			columns: [table.siteId, table.postTypeId],
			foreignColumns: [postTypes.siteId, postTypes.id],
		}).onDelete("cascade"),
		unique("templates_site_id_kind_post_type_id_unique")
			.on(table.siteId, table.kind, table.postTypeId)
			.nullsNotDistinct(),
	],
);
