import { boolean, foreignKey, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { sites } from "./tenancy.ts";

// The Design system (ADR 0009): a Site's Design tokens, Classes and custom CSS. Site data, like the
// content store: every row carries `workspace_id` and `site_id`, with a foreign key to
// `sites (workspace_id, id)`.

/**
 * Classes: named sets of styles that elements reference by id (ADR 0009). So far only generated
 * Classes exist, made from inline styles in Template markup: `styles` holds their CSS declarations
 * in canonical form (`color: red; margin: 0 auto;`). The Design system's own Classes, their Draft
 * and published versions and the stylesheet build on this table.
 */
export const classes = pgTable(
	"classes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The class name pages carry, such as `card` or `style-1a2b3c4d`. Unique on the Site. */
		name: text("name").notNull(),
		/** CSS declarations, in canonical form. */
		styles: text("styles").notNull().default(""),
		/** Made by WebCraft from an inline style, rather than by Staff. */
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
