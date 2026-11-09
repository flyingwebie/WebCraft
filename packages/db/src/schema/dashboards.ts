import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

// Dashboards (#103, GLOSSARY.md): grids of Widgets showing a Site's analytics, or a Workspace's Sites
// added together, built by Staff. Their Widgets (kind, place on the grid, range, filters, settings)
// are kept as JSON with the Dashboard, read and written whole (`@webcraft/core` › dashboards), and the
// data they show is worked out when someone looks, by the Modules that add them (SDK 1.8).

/** A Site's Dashboards (a Site table). */
export const dashboards = pgTable(
	"dashboards",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		name: text("name").notNull(),
		/** The range Widgets show unless they have their own (`DashboardRange`). */
		range: jsonb("range").notNull(),
		/** Whether everyone who works on the Site sees it (Editors and Authors too), not only Staff and Owners. */
		sharedWithEveryone: boolean("shared_with_everyone").notNull().default(false),
		/** Its Widgets, in the order they were added (`StoredWidget[]`). */
		widgets: jsonb("widgets").notNull().default(sql`'[]'::jsonb`),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		foreignKey({
			name: "dashboards_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("dashboards_site_id_idx").on(table.siteId),
	],
);

/** Workspace Dashboards (a Workspace table): their Widgets add up the Workspace's Sites. */
export const workspaceDashboards = pgTable(
	"workspace_dashboards",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		range: jsonb("range").notNull(),
		/** Whether everyone who works in the Workspace sees it, not only Staff and Owners. */
		sharedWithEveryone: boolean("shared_with_everyone").notNull().default(false),
		widgets: jsonb("widgets").notNull().default(sql`'[]'::jsonb`),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [index("workspace_dashboards_workspace_id_idx").on(table.workspaceId)],
);

/**
 * Dashboard templates (a Workspace table): a Dashboard's Widgets and range, kept to start other
 * Dashboards from, on any Site (or Workspace) of a Workspace the person builds Dashboards in. Widgets
 * name Goals and Funnels by name, so a template finds the Goals of the same name where it is used.
 */
export const dashboardTemplates = pgTable(
	"dashboard_templates",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		range: jsonb("range").notNull(),
		widgets: jsonb("widgets").notNull(),
		/** The name of the Dashboard it was made from, as it was then. */
		madeFrom: text("made_from").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [index("dashboard_templates_workspace_id_idx").on(table.workspaceId)],
);
