import { pgSchema, uuid } from "drizzle-orm/pg-core";

/**
 * A Module's tables. Each Module keeps its tables in its own Postgres schema, `m_<id>` (dashes
 * become underscores: `site-analytics` keeps `m_site_analytics.events`), and follows the same rule
 * as WebCraft's own tenant tables (ADR 0007):
 *
 * - a **Site table** has `workspace_id` and `site_id`, with a foreign key to
 *   `sites (workspace_id, id)` that deletes its rows with the Site;
 * - a **Workspace table** has `workspace_id`, with a foreign key to `workspaces (id)` that deletes
 *   its rows with the Workspace.
 *
 * A Site-level Module has Site tables only; a Workspace-level Module may have both. Declare them
 * with Drizzle's column builders, through this schema:
 *
 *     const schema = moduleSchema("sample");
 *     export const notes = schema.table("notes", {
 *       ...siteColumns(),
 *       id: uuid("id").primaryKey().defaultRandom(),
 *       body: text("body").notNull(),
 *     });
 *
 * and create them in the Module's migrations (see `ModuleMigration`). WebCraft fills in the
 * Workspace and Site when the Module inserts a row, and only ever shows it its own place's rows.
 */

/** The Postgres schema a Module's tables live in: `m_` and its id, with dashes as underscores. */
export function moduleSchemaName(moduleId: string): string {
	return `m_${moduleId.replaceAll("-", "_")}`;
}

/** The Postgres schema of a Module's tables: `moduleSchema("sample").table("notes", { … })`. */
export function moduleSchema(moduleId: string) {
	return pgSchema(moduleSchemaName(moduleId));
}

/** The columns every Site table starts with. WebCraft fills them in. */
export function siteColumns() {
	return { workspaceId: uuid("workspace_id").notNull(), siteId: uuid("site_id").notNull() };
}

/** The column every Workspace table starts with. WebCraft fills it in. */
export function workspaceColumns() {
	return { workspaceId: uuid("workspace_id").notNull() };
}

/**
 * One step of a Module's migrations: SQL that creates or changes its tables. They run in order,
 * once each, in the `migrate` step (`webcraft admin migrate`), after WebCraft's own migrations,
 * with the Module's schema first on the search path: `CREATE TABLE notes (…)` creates
 * `m_sample.notes`, and `REFERENCES sites (workspace_id, id)` reaches WebCraft's Sites.
 *
 * Never change or remove a migration that shipped: add a new one. Like WebCraft's own, each one
 * must keep the previous version of the Module working (ADR 0031). WebCraft refuses a migration
 * that changes anything outside the Module's schema, and tables that don't follow the rule above
 * or that the Module doesn't declare.
 */
export type ModuleMigration = {
	/** A name that sorts after the ones before it: `0001-notes`, `0002-note-colours`. */
	name: string;
	sql: string;
};
