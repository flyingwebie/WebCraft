import { sql } from "drizzle-orm";
import { foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

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

/**
 * Components: reusable element trees with Props, made by Staff (Structure). Each version holds the
 * Component's Props (Field definitions) and its element tree, published together as one item:
 * `{ props, tree }`. Templates and other Components place one by its id, so renaming it changes
 * only how Template markup writes the tag. Components a Module declares aren't stored here: they
 * come from the Module's definition.
 */
export const components = pgTable(
	"components",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** Its PascalCase tag name in Template markup, such as `PostCard`. Unique on the Site. */
		name: text("name").notNull(),
		/** The Draft: `{ props, tree }`. */
		draft: jsonb("draft").notNull(),
		/** The published version, `{ props, tree }`; null until the first publish. */
		published: jsonb("published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "components_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("components_site_id_id_unique").on(table.siteId, table.id),
		unique("components_site_id_name_unique").on(table.siteId, table.name),
	],
);

/**
 * Scripts Staff write in Code mode (ADR 0016): the Site script (`kind = 'site'`, one per Site, on
 * every page) and page scripts (`kind = 'page'`, one per Entry, on its page only). Structure with a
 * Draft and a published version, as text. Pages never carry them inline (ADR 0023): each version is
 * a file named by the hash of its text, `draft_hash` and `published_hash` (16 hexadecimal digits of
 * its SHA-256), served from the Site's own domain.
 */
export const scripts = pgTable(
	"scripts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** `site` or `page`. */
		kind: text("kind").notNull(),
		/** The Entry whose page a page script runs on; null for the Site script. */
		entryId: uuid("entry_id"),
		draft: text("draft").notNull(),
		draftHash: text("draft_hash").notNull(),
		/** What visitors run; null until the first publish. */
		published: text("published"),
		publishedHash: text("published_hash"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "scripts_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "scripts_entry_fkey",
			columns: [table.siteId, table.entryId],
			foreignColumns: [entries.siteId, entries.id],
		}).onDelete("cascade"),
		unique("scripts_site_id_kind_entry_id_unique").on(table.siteId, table.kind, table.entryId).nullsNotDistinct(),
		index("scripts_site_id_published_hash_idx").on(table.siteId, table.publishedHash),
		index("scripts_site_id_draft_hash_idx").on(table.siteId, table.draftHash),
	],
);

/**
 * Loops: repeated parts of a Site, made by Staff (Structure) and placed in Templates and Components
 * by name (`{{@loop latest-posts as post}}`). Each version says where the items come from (a query
 * over Entries, or the Loop's own Loop items) and holds the Loop items' Fields and values:
 * `{ source, query, fields, values }`, the items stored like a Repeater's rows under `values.items`,
 * per Field and per language (ADR 0003). Published as one item.
 */
export const loops = pgTable(
	"loops",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** How Template markup names it, such as `latest-posts`. Unique on the Site; it never changes. */
		name: text("name").notNull(),
		/** The Draft: `{ source, query, fields, values }`. */
		draft: jsonb("draft").notNull(),
		/** The published version; null until the first publish. */
		published: jsonb("published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "loops_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("loops_site_id_id_unique").on(table.siteId, table.id),
		unique("loops_site_id_name_unique").on(table.siteId, table.name),
	],
);

/**
 * The links Relationship values make: one row per Entry, version, Relationship Field and Entry
 * pointed at, written whenever a Draft is saved or published. The values themselves stay in the
 * versions; these rows let WebCraft find what points at an Entry (the link back of a two-way
 * Relationship, and what deleting it would unlink) with one indexed lookup. Rows go when either
 * Entry is deleted.
 */
export const entryLinks = pgTable(
	"entry_links",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The Entry whose Relationship value makes the link. */
		entryId: uuid("entry_id").notNull(),
		/** Which version of it: `draft` or `published`. */
		version: text("version").notNull(),
		/** The Relationship Field's definition path, such as `categories` or `team.person` inside a Repeater. */
		field: text("field").notNull(),
		/** The Entry pointed at. */
		targetId: uuid("target_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.entryId, table.version, table.field, table.targetId] }),
		foreignKey({
			name: "entry_links_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "entry_links_entry_fkey",
			columns: [table.siteId, table.entryId],
			foreignColumns: [entries.siteId, entries.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "entry_links_target_fkey",
			columns: [table.siteId, table.targetId],
			foreignColumns: [entries.siteId, entries.id],
		}).onDelete("cascade"),
		index("entry_links_site_id_target_id_idx").on(table.siteId, table.targetId),
	],
);

/**
 * A Site's Globals: one set of Fields per Site (its phone number, address, footer text), defined by
 * Staff, with values in a Draft and a published version like an Entry's. Field changes apply at once;
 * values go live when the Globals are published. The row is made the first time it is needed.
 */
export const globals = pgTable(
	"globals",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The Fields, in order: a JSON list of Field definitions. */
		fields: jsonb("fields").notNull().default(sql`'[]'::jsonb`),
		/** The Draft values. */
		draft: jsonb("draft").notNull(),
		/** The published values visitors see; null until the first publish. */
		published: jsonb("published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** When the Fields or the Draft last changed. */
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "globals_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("globals_site_id_unique").on(table.siteId),
	],
);

/**
 * Two-step confirmations (spec › Management API): the first call of a destructive procedure answers
 * a preview (how many links deleting an Entry removes) and the id of one of these rows; the second
 * call passes the id back to go ahead. A confirmation belongs to one person, one action and one
 * target, holds the preview it was given for, lasts 5 minutes and works once. It is asked in a Site
 * (`site_id` set) or in a Workspace as a whole (`site_id` null, such as removing a Workspace-level
 * Module's data).
 */
export const confirmations = pgTable(
	"confirmations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		siteId: uuid("site_id"),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		/** What is confirmed, as an Audit log action: `entry.delete`. */
		action: text("action").notNull(),
		/** What it is done to, such as the Entry's id. */
		target: text("target").notNull(),
		/** The preview the person saw; the action goes ahead only while it is still the same. */
		preview: jsonb("preview").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "confirmations_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);

/**
 * The Pages a Site gives a special job: `home` answers at `/` (and at each language's prefix), and
 * `notFound` answers every path with no page, with status 404. Staff choose them (Structure); a Page
 * that is deleted gives its job up, and the Site falls back to no home page and the built-in 404 page.
 * A 404 page may be chosen for one language (`language`); the one without a language answers in the
 * others.
 */
export const specialPages = pgTable(
	"special_pages",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The Page's job: `home` or `notFound`. */
		role: text("role").notNull(),
		/** The language the Page has its job in; null for every language without one of its own. */
		language: text("language"),
		/** The Page, an Entry of the Site's Page Post Type. */
		entryId: uuid("entry_id").notNull(),
	},
	(table) => [
		unique("special_pages_site_id_role_language_unique")
			.on(table.siteId, table.role, table.language)
			.nullsNotDistinct(),
		foreignKey({
			name: "special_pages_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "special_pages_entry_fkey",
			columns: [table.siteId, table.entryId],
			foreignColumns: [entries.siteId, entries.id],
		}).onDelete("cascade"),
	],
);
