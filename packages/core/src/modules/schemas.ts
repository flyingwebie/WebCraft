import type { ModuleSchema } from "@webcraft/db";
import type { AnyModuleDefinition } from "@webcraft/module-sdk";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { loadModules, type ModuleRegistry } from "./registry.ts";

/**
 * What the `migrate` step and the schema check need to know about Modules: each runnable Module's
 * schema, migrations and declared tables. A Module WebCraft can't run has no migrations applied.
 */
export function moduleSchemas(definitions: readonly AnyModuleDefinition[]): ModuleSchema[] {
	return schemasOf(loadModules(definitions));
}

/** `moduleSchemas` for Modules already loaded. */
export function schemasOf(registry: ModuleRegistry): ModuleSchema[] {
	return registry.all().flatMap((module) =>
		module.runnable
			? [
					{
						moduleId: module.id,
						schema: module.schema,
						migrations: module.definition.migrations ?? [],
						tables: [...module.tables].map((table) => {
							const columns = getTableConfig(table).columns.map((column) => column.name);
							const partitioning = module.partitions.find((each) => each.table === table);
							return {
								name: getTableName(table),
								kind: columns.includes("site_id") ? ("site" as const) : ("workspace" as const),
								columns,
								...(partitioning ? { partitionedBy: partitioning.column } : {}),
							};
						}),
					},
				]
			: [],
	);
}
