import { boolean, foreignKey, jsonb, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { sites } from "./tenancy.ts";

/** Structure settings for the Member Page layout editor, independent of Content publication. */
export const pageLayoutSettings = pgTable(
	"page_layout_settings",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		enabled: boolean("enabled").notNull().default(false),
		allowedComponents: jsonb("allowed_components").$type<string[]>().notNull().default([]),
	},
	(table) => [
		primaryKey({ columns: [table.siteId] }),
		foreignKey({ columns: [table.workspaceId, table.siteId], foreignColumns: [sites.workspaceId, sites.id] }).onDelete(
			"cascade",
		),
	],
);
