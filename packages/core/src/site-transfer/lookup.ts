import type pg from "pg";
import { literal, quoted } from "./tables.ts";

/** Current Drafts and live versions use today's Structure; history uses Structure from that time. */
export type ReferenceVersion = { kind: "draft" | "published"; at?: string };

/** Reads one bounded piece of the original Structure, before any identities have changed. */
export type ReferenceLookup = {
	row(table: string, id: string | null, path: string[]): Promise<unknown>;
	prop(componentId: string, path: string[], version: ReferenceVersion): Promise<unknown>;
};

/** Both the export's scoped snapshot and the import's staged original rows obey the same lookup. */
export function createReferenceLookup(
	client: pg.ClientBase,
	site?: { workspaceId: string; id: string },
): ReferenceLookup {
	const scope = site ? [site.workspaceId, site.id] : [];
	const parameter = (index: number) => `$${scope.length + index}`;
	const rows = (name: string) => {
		if (!site) return `SELECT line::jsonb AS row FROM site_import_source_rows WHERE table_name = ${literal(name)}`;
		const [schema, table] = name.split(".") as [string, string];
		return `SELECT to_jsonb(t) AS row FROM ${quoted({ schema, table })} t WHERE t.workspace_id = $1 AND t.site_id = $2`;
	};
	return {
		async row(table, id, path) {
			const result = await client.query<{ value: unknown }>(
				`SELECT row #> ${parameter(2)}::text[] AS value FROM (${rows(table)}) source
 WHERE (${parameter(1)}::text IS NULL OR row->>'id' = ${parameter(1)}) LIMIT 1`,
				[...scope, id, path],
			);
			return result.rows[0]?.value;
		},
		async prop(componentId, path, version) {
			// Prefer the declaration that existed when this copy was written. If retention removed
			// it, use surviving Structure as restoring that copy on the source Site would.
			const fields = path.map((_, index) => `f${index}`);
			const joins = fields.map(
				(field, index) =>
					`CROSS JOIN LATERAL jsonb_array_elements(COALESCE(${index === 0 ? "content->'props'" : `${fields[index - 1]}.value->'fields'`}, '[]'::jsonb)) ${field}(value)`,
			);
			const matches = fields.map((field, index) => `${field}.value->>'key' = ${parameter(index + 4)}`);
			const result = await client.query<{ value: unknown }>(
				`WITH versions AS (
 SELECT row->'draft' AS content, row->>'updated_at' AS at, 'draft' AS kind, 0 AS priority
 FROM (${rows("public.components")}) source WHERE row->>'id' = ${parameter(1)}
 UNION ALL
 SELECT row->'published', row->>'last_published_at', 'published', 0
 FROM (${rows("public.components")}) source WHERE row->>'id' = ${parameter(1)}
 UNION ALL
 SELECT row->'content', row->>'published_at', 'published', 1
 FROM (${rows("public.revisions")}) source WHERE row->>'item_kind' = 'component' AND row->>'item_id' = ${parameter(1)}
 UNION ALL
 SELECT row->'content', row->>'changed_at', 'draft', 1
 FROM (${rows("public.checkpoints")}) source WHERE row->>'item_kind' = 'component' AND row->>'item_id' = ${parameter(1)}
 ), candidates AS (
 SELECT ${fields.at(-1)}.value, priority, kind, at::timestamptz AS at,
 (${parameter(3)}::timestamptz IS NOT NULL AND at::timestamptz <= ${parameter(3)}::timestamptz) AS historical
 FROM versions ${joins.join(" ")} WHERE ${matches.join(" AND ")}
 )
 SELECT value FROM candidates
 ORDER BY CASE WHEN historical THEN 0 ELSE 1 END,
 CASE WHEN historical THEN 0 ELSE priority END,
 CASE WHEN historical AND ${parameter(2)} = 'draft' THEN 0 WHEN kind = ${parameter(2)} THEN 0 ELSE 1 END,
 at DESC NULLS LAST, CASE WHEN kind = ${parameter(2)} THEN 0 ELSE 1 END
 LIMIT 1`,
				[...scope, componentId, version.kind, version.at ?? null, ...path],
			);
			return result.rows[0]?.value;
		},
	};
}
