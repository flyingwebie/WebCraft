import { boolean, foreignKey, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { components, entries } from "./content.ts";
import { sites } from "./tenancy.ts";

/** References only: the statement itself is ordinary Page Content, with normal Drafts and translations. */
export const accessibilityStatements = pgTable(
	"accessibility_statements",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").primaryKey(),
		pageId: uuid("page_id").notNull(),
		componentId: uuid("component_id").notNull(),
		fieldKey: text("field_key").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		/** Last form supplied in each language; never the source of rendered Content. */
		forms: jsonb("forms").notNull().default({}),
	},
	(t) => [
		foreignKey({ columns: [t.workspaceId, t.siteId], foreignColumns: [sites.workspaceId, sites.id] }).onDelete(
			"cascade",
		),
		foreignKey({ columns: [t.siteId, t.pageId], foreignColumns: [entries.siteId, entries.id] }).onDelete("cascade"),
		foreignKey({ columns: [t.siteId, t.componentId], foreignColumns: [components.siteId, components.id] }).onDelete(
			"cascade",
		),
	],
);
