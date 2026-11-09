import { type ModuleData, ModuleRefusedError, type ModuleTable, type NewModuleRow } from "@webcraft/module-sdk";
import { getTableName, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { clearPageCache } from "../content/page-cache.ts";
import type { ScopedQueries, SiteScope, SiteTable, WorkspaceScope, WorkspaceTable } from "../tenancy/data-layer.ts";
import type { RunnableModule } from "./registry.ts";

/** A Site or a Workspace, opened through the data layer: where a Module acts, or where Staff switch it. */
export type PlaceScope = SiteScope | WorkspaceScope;

/**
 * The scope's queries, for any tenant table, with one signature: a Site scope's take Site tables and
 * a Workspace scope's Workspace tables, which TypeScript can't call through the union.
 */
export function placeQueries(scope: PlaceScope): ScopedQueries<WorkspaceTable, "workspaceId"> {
	return scope as unknown as ScopedQueries<WorkspaceTable, "workspaceId">;
}

/**
 * A Module's tables, limited to the place `scope` opened: the data layer adds the place's condition
 * to every query and fills in the Workspace (and Site); a table that isn't one of the Module's is
 * refused. A change to a table its Redirect rules read (SDK 1.4) clears the Site's page cache with
 * it, as the Site pipeline keeps their answers with the Site's pages.
 */
export function moduleData(
	module: RunnableModule,
	scope: PlaceScope,
	options: { inTransaction?: boolean } = {},
): ModuleData {
	const queries = placeQueries(scope);
	const own = <Table extends ModuleTable>(table: Table): Table & WorkspaceTable => {
		if (!module.tables.has(table)) {
			let name = "something that isn't a table";
			try {
				name = getTableName(table as PgTable);
			} catch {
				// Not a table at all.
			}
			throw new ModuleRefusedError("table", `The table ${name} isn't one of the Module ${module.id}'s tables.`);
		}
		return table as Table & WorkspaceTable;
	};
	/** A new row: in a Site the Site is filled in; in a Workspace a Site table's row names its Site. */
	const values = <Table extends ModuleTable>(table: Table, row: NewModuleRow<Table> | Partial<NewModuleRow<Table>>) =>
		(scope.level === "site" && "siteId" in table ? { ...row, siteId: scope.site.id } : row) as never;
	// In one transaction the Site's pages go once: nobody sees the change before it commits.
	let cleared = false;
	/** After a change to a table the Site pipeline keeps answers of: the Site's pages go, with the change. */
	const changed = async <Result>(table: ModuleTable, result: Result, rows: number): Promise<Result> => {
		if (rows === 0 || scope.level !== "site" || !module.redirects?.tables.includes(table)) return result;
		if (cleared && options.inTransaction) return result;
		await clearPageCache(scope);
		cleared = true;
		return result;
	};
	return {
		select: (table, where?: SQL, options = {}) => queries.select(own(table), where, options) as never,
		first: (table, where?: SQL, options = {}) => queries.first(own(table), where, options) as never,
		count: (table, where?: SQL) => queries.count(own(table), where),
		insert: async (table, row) => {
			const inserted = await queries.insert(own(table), values(table, row));
			return changed(table, inserted, 1) as never;
		},
		update: async (table, set, where?: SQL) => {
			const { siteId: _site, ...rest } = set as Record<string, unknown>;
			const updated = await queries.update(own(table), rest as never, where);
			return changed(table, updated, updated.length) as never;
		},
		delete: async (table, where?: SQL) => {
			const deleted = await queries.delete(own(table), where);
			return changed(table, deleted, deleted);
		},
	};
}

/** Whether a table is a Site table, by its columns. */
export function isSiteTable(table: ModuleTable): table is ModuleTable & SiteTable {
	return "siteId" in table;
}
