import { type ModuleData, ModuleRefusedError, type ModuleTable, type NewModuleRow } from "@webcraft/module-sdk";
import { getTableName, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

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
 * refused.
 */
export function moduleData(module: RunnableModule, scope: PlaceScope): ModuleData {
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
	return {
		select: (table, where?: SQL, options = {}) => queries.select(own(table), where, options) as never,
		first: (table, where?: SQL, options = {}) => queries.first(own(table), where, options) as never,
		count: (table, where?: SQL) => queries.count(own(table), where),
		insert: (table, row) => queries.insert(own(table), values(table, row)) as never,
		update: (table, set, where?: SQL) => {
			const { siteId: _site, ...rest } = set as Record<string, unknown>;
			return queries.update(own(table), rest as never, where) as never;
		},
		delete: (table, where?: SQL) => queries.delete(own(table), where),
	};
}

/** Whether a table is a Site table, by its columns. */
export function isSiteTable(table: ModuleTable): table is ModuleTable & SiteTable {
	return "siteId" in table;
}
