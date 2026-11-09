import { foreignKey, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites } from "./tenancy.ts";

// Filters (`@webcraft/core` › filters, GLOSSARY.md): controls visitors use to narrow, search and sort
// the items of one query Loop. A Filter is Structure with a Draft and a published version, like a
// Loop; what visitors choose lives in their page's address, never here.

/**
 * The Site's Filters. Each version (`draft`, `published`) is a `FilterVersion`: its controls in order
 * (their URL keys, sources, labels in every language), when results update with JavaScript and its
 * own words. A Filter narrows one query Loop, `loop` by name, chosen when it is made: a Loop has at
 * most one Filter, and Template markup places it as `{{@filter <name> for="<loop>"}}`.
 */
export const filters = pgTable(
	"filters",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** How Template markup names it, `{{@filter shop for="products"}}`: lower-case words joined by dashes. Unique on the Site; it never changes. */
		name: text("name").notNull(),
		/** The query Loop it narrows, by name (Loop names never change). One Filter per Loop. */
		loop: text("loop").notNull(),
		draft: jsonb("draft").notNull(),
		/** What visitors use; null until the first publish. */
		published: jsonb("published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		/** Who last changed the Draft (null when nobody did, or they are gone): what Publish all says. */
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
		/** The API client or AI client the Draft was last changed through (its name), or null: in the admin or Edit mode. */
		updatedVia: text("updated_via"),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "filters_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("filters_site_id_id_unique").on(table.siteId, table.id),
		unique("filters_site_id_name_unique").on(table.siteId, table.name),
		unique("filters_site_id_loop_unique").on(table.siteId, table.loop),
	],
);
