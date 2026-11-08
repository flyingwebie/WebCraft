import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * Module migrations, as the `migrate` step applies them (ADR 0031): after WebCraft's own, all in
 * one transaction. Each Module keeps its tables in its own Postgres schema (`m_<id>`) and ships its
 * migrations as SQL; each runs once, recorded in `module_migrations` with a checksum. WebCraft
 * refuses, and the whole step rolls back, when a Module's migrations:
 *
 * - change anything outside its schema (WebCraft's tables, another Module's, roles, extensions);
 * - leave a table in its schema that it doesn't declare, a view, or a table that doesn't follow the
 *   tenant rule (a Site table's `(workspace_id, site_id)` points at `sites (workspace_id, id)`, a
 *   Workspace table's `workspace_id` at `workspaces (id)`, both deleting with them);
 * - miss a table or column the Module declares;
 * - changed, or lost, a migration that was applied before.
 */
export type ModuleSchema = {
	moduleId: string;
	/** Its Postgres schema, `m_<id>`. */
	schema: string;
	migrations: readonly { name: string; sql: string }[];
	/** The tables it declares, with their columns. */
	tables: readonly { name: string; kind: "site" | "workspace"; columns: readonly string[] }[];
};

/** A Module's migrations broke a rule: nothing was applied. */
export class ModuleMigrationError extends Error {
	override name = "ModuleMigrationError";
}

type Client = pg.PoolClient;

/** The checksum a migration is recorded with. */
export function migrationChecksum(sql: string): string {
	return createHash("sha256").update(sql).digest("hex");
}

/** Applies every Module's pending migrations, in one transaction. Answers what it applied, as `<module>/<name>`. */
export async function applyModuleMigrations(pool: pg.Pool, modules: readonly ModuleSchema[]): Promise<string[]> {
	if (modules.length === 0) return [];
	const client = await pool.connect();
	const applied: string[] = [];
	try {
		await client.query("BEGIN");
		for (const module of modules) {
			for (const name of await migrateModule(client, module)) applied.push(`${module.moduleId}/${name}`);
		}
		await client.query("COMMIT");
		return applied;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

/** The Module migrations this build has that the database hasn't had, as `<module>/<name>`. */
export async function pendingModuleMigrations(pool: pg.Pool, modules: readonly ModuleSchema[]): Promise<string[]> {
	if (modules.length === 0) return [];
	const exists = await pool.query<{ found: string | null }>("SELECT to_regclass('public.module_migrations') AS found");
	const applied = new Set<string>();
	if (exists.rows[0]?.found) {
		const rows = await pool.query<{ module_id: string; name: string }>(
			"SELECT module_id, name FROM public.module_migrations",
		);
		for (const row of rows.rows) applied.add(`${row.module_id}/${row.name}`);
	}
	return modules.flatMap((module) =>
		module.migrations.map((migration) => `${module.moduleId}/${migration.name}`).filter((key) => !applied.has(key)),
	);
}

async function migrateModule(client: Client, module: ModuleSchema): Promise<string[]> {
	const { moduleId, schema } = module;
	const recorded = await client.query<{ name: string; checksum: string }>(
		"SELECT name, checksum FROM public.module_migrations WHERE module_id = $1",
		[moduleId],
	);
	const byName = new Map(module.migrations.map((migration) => [migration.name, migration]));
	for (const row of recorded.rows) {
		const migration = byName.get(row.name);
		if (!migration) {
			throw new ModuleMigrationError(
				`The Module ${moduleId}'s migration ${row.name} was applied, but the Module no longer has it. Never remove a migration that shipped.`,
			);
		}
		if (migrationChecksum(migration.sql) !== row.checksum) {
			throw new ModuleMigrationError(
				`The Module ${moduleId}'s migration ${row.name} changed after it was applied. Never change a migration that shipped: add a new one.`,
			);
		}
	}
	const done = new Set(recorded.rows.map((row) => row.name));
	const pending = module.migrations.filter((migration) => !done.has(migration.name));
	if (pending.length > 0) {
		const before = await outsideDigest(client, schema);
		await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
		await client.query(`SET LOCAL search_path TO ${ident(schema)}, public`);
		for (const migration of pending) {
			try {
				await client.query(migration.sql);
			} catch (error) {
				throw new ModuleMigrationError(
					`The Module ${moduleId}'s migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			await client.query(
				"INSERT INTO public.module_migrations (module_id, name, checksum, applied_at) VALUES ($1, $2, $3, now())",
				[moduleId, migration.name, migrationChecksum(migration.sql)],
			);
		}
		await client.query("SET LOCAL search_path TO DEFAULT");
		if ((await outsideDigest(client, schema)) !== before) {
			throw new ModuleMigrationError(
				`The Module ${moduleId}'s migrations changed something outside its own schema, ${schema}. A Module only changes its own tables.`,
			);
		}
	}
	await checkTables(client, module);
	return pending.map((migration) => migration.name);
}

/**
 * Everything in the database outside `schema` that a migration could change, as one digest: schemas,
 * tables and other relations with their columns and grants, constraints, triggers, functions, types,
 * policies and extensions. Postgres's own schemas aren't part of it.
 */
async function outsideDigest(client: Client, schema: string): Promise<string> {
	const outside = `n.nspname <> $1 AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;
	const { rows } = await client.query<{ digest: string }>(
		`SELECT md5(coalesce(string_agg(item, E'\\n' ORDER BY item), '')) AS digest FROM (
			SELECT 'schema:' || n.nspname || ':' || coalesce(n.nspacl::text, '') AS item FROM pg_namespace n WHERE ${outside}
			UNION ALL
			SELECT 'relation:' || n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity::text || ':' ||
				coalesce((SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
					FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
					WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '')
				FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${outside}
			UNION ALL
			SELECT 'constraint:' || n.nspname || '.' || o.conname || ':' || pg_get_constraintdef(o.oid)
				FROM pg_constraint o JOIN pg_namespace n ON n.oid = o.connamespace WHERE ${outside}
			UNION ALL
			SELECT 'trigger:' || n.nspname || '.' || c.relname || '.' || t.tgname || ':' || t.tgenabled::text
				FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE NOT t.tgisinternal AND ${outside}
			UNION ALL
			SELECT 'function:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(coalesce(p.prosrc, ''))
				FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${outside}
			UNION ALL
			SELECT 'type:' || n.nspname || '.' || t.typname
				FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typtype IN ('b', 'd', 'e', 'r', 'm') AND ${outside}
			UNION ALL
			SELECT 'policy:' || c.relname || '.' || p.polname
				FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${outside}
			UNION ALL
			SELECT 'extension:' || e.extname || ':' || e.extversion FROM pg_extension e
		) items`,
		[schema],
	);
	return rows[0]?.digest ?? "";
}

/** Every relation in the Module's schema is a table it declares, following the tenant rule, with its declared columns. */
async function checkTables(client: Client, module: ModuleSchema): Promise<void> {
	const { moduleId, schema } = module;
	const refuse = (message: string): never => {
		throw new ModuleMigrationError(`The Module ${moduleId}: ${message}`);
	};
	const relations = await client.query<{ name: string; kind: string }>(
		`SELECT c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
		[schema],
	);
	const declared = new Map(module.tables.map((table) => [table.name, table]));
	for (const relation of relations.rows) {
		if (relation.kind !== "r" && relation.kind !== "p")
			refuse(`${schema}.${relation.name} isn't a table; Modules keep tables only.`);
		if (!declared.has(relation.name))
			refuse(`its migrations made the table ${schema}.${relation.name}, which it doesn't declare.`);
	}
	const present = new Set(relations.rows.map((relation) => relation.name));
	for (const table of module.tables) {
		const qualified = `${schema}.${table.name}`;
		if (!present.has(table.name)) refuse(`it declares the table ${qualified}, which its migrations don't make.`);
		const columns = await client.query<{ name: string; type: string; notNull: boolean }>(
			`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull"
				FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
			[`${ident(schema)}.${ident(table.name)}`],
		);
		const byName = new Map(columns.rows.map((column) => [column.name, column]));
		for (const name of table.columns) {
			if (!byName.has(name)) refuse(`it declares the column ${qualified}.${name}, which its migrations don't make.`);
		}
		const tenantColumns = table.kind === "site" ? ["workspace_id", "site_id"] : ["workspace_id"];
		for (const name of tenantColumns) {
			const column = byName.get(name);
			if (column?.type !== "uuid" || !column.notNull) refuse(`${qualified}.${name} must be a uuid that is never null.`);
		}
		const keys = await client.query<{ target: string; onDelete: string; columns: string[]; targetColumns: string[] }>(
			`SELECT CASE WHEN con.confrelid = 'public.sites'::regclass THEN 'sites'
					WHEN con.confrelid = 'public.workspaces'::regclass THEN 'workspaces' ELSE '' END AS target,
				con.confdeltype AS "onDelete",
				(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
					JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
				(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
					JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS "targetColumns"
				FROM pg_constraint con WHERE con.contype = 'f' AND con.conrelid = $1::regclass`,
			[`${ident(schema)}.${ident(table.name)}`],
		);
		const tenantKey = keys.rows.some((key) =>
			table.kind === "site"
				? key.target === "sites" &&
					key.onDelete === "c" &&
					same(key.columns, ["workspace_id", "site_id"]) &&
					same(key.targetColumns, ["workspace_id", "id"])
				: key.target === "workspaces" &&
					key.onDelete === "c" &&
					same(key.columns, ["workspace_id"]) &&
					same(key.targetColumns, ["id"]),
		);
		if (!tenantKey) {
			refuse(
				table.kind === "site"
					? `${qualified} needs FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE.`
					: `${qualified} needs FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE.`,
			);
		}
	}
}

function same(a: readonly string[] | null, b: readonly string[]): boolean {
	return a !== null && a.length === b.length && a.every((value, index) => value === b[index]);
}

/** A Postgres identifier, quoted. */
function ident(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}
