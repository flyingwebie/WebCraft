import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * Module migrations, as the `migrate` step applies them (ADR 0031): after WebCraft's own, each in
 * its own transaction. Each Module keeps its tables in its own Postgres schema (`m_<id>`) and ships
 * its migrations as SQL; each runs once, recorded in `module_migrations` with a checksum. WebCraft
 * refuses a migration, rolling it back and stopping the step (the migrations before it stay
 * applied), when it:
 *
 * - changes anything outside its schema (WebCraft's tables, another Module's, roles, extensions),
 *   rows included, or reads a table outside it other than `sites` and `workspaces` (which its
 *   foreign keys point at);
 *
 * and, checked with the Module's last pending migration (and on every run), when the Module's
 * migrations together:
 *
 * - leave a table in its schema that it doesn't declare, a view, or a table that doesn't follow the
 *   tenant rule (a Site table's `(workspace_id, site_id)` points at `sites (workspace_id, id)`, a
 *   Workspace table's `workspace_id` at `workspaces (id)`, both deleting with them);
 * - miss a table or column the Module declares, or make a table it keeps in monthly partitions
 *   (SDK 1.4) without partitioning it by range on the declared column;
 * - changed, or lost, a migration that was applied before.
 *
 * A database can be ahead of a Module: after going back one WebCraft version, migrations the newer
 * version applied are recorded but not in this build. They sort after every migration the build
 * has, and are accepted (with the tables they made): the add-first rule keeps them working.
 *
 * The partitions of a partitioned table are WebCraft's to make and drop, not the migrations'.
 */
export type ModuleSchema = {
	moduleId: string;
	/** Its Postgres schema, `m_<id>`. */
	schema: string;
	migrations: readonly { name: string; sql: string }[];
	/** The tables it declares, with their columns (and the column a partitioned one is partitioned by). */
	tables: readonly { name: string; kind: "site" | "workspace"; columns: readonly string[]; partitionedBy?: string }[];
};

/** A Module's migrations broke a rule: the migration that did was rolled back. */
export class ModuleMigrationError extends Error {
	override name = "ModuleMigrationError";
}

type Client = pg.PoolClient;

/**
 * How one migration's statements are kept together, so a failed one leaves nothing behind: a
 * transaction of its own, or a savepoint inside a transaction the caller holds (a restore rebuilds
 * and loads a whole database in one), where nothing is committed before the caller commits.
 */
export type MigrationUnit = { begin: string; commit: string; rollback: string };

export const OWN_TRANSACTION: MigrationUnit = { begin: "BEGIN", commit: "COMMIT", rollback: "ROLLBACK" };

export const WITHIN_TRANSACTION: MigrationUnit = {
	begin: "SAVEPOINT webcraft_migration",
	commit: "RELEASE SAVEPOINT webcraft_migration",
	rollback: "ROLLBACK TO SAVEPOINT webcraft_migration",
};

/** The checksum a migration is recorded with. */
export function migrationChecksum(sql: string): string {
	return createHash("sha256").update(sql).digest("hex");
}

/**
 * Applies every Module's pending migrations, each in its own transaction (or under a savepoint of the
 * caller's: `unit`). Answers what it applied, as `<module>/<name>`. With `partial` (a restore
 * rebuilding an older level), the Modules' tables aren't checked against what they declare: later
 * migrations make the rest.
 */
export async function applyModuleMigrations(
	client: Client,
	modules: readonly ModuleSchema[],
	options: { partial?: boolean; unit?: MigrationUnit } = {},
): Promise<string[]> {
	if (modules.length === 0) return [];
	const applied: string[] = [];
	for (const module of modules) {
		const names = await migrateModule(client, module, options.partial === true, options.unit ?? OWN_TRANSACTION);
		for (const name of names) {
			applied.push(`${module.moduleId}/${name}`);
		}
	}
	return applied;
}

/** The Module migrations this build has that the database hasn't had, as `<module>/<name>`. */
export async function pendingModuleMigrations(
	pool: pg.Pool | pg.PoolClient,
	modules: readonly ModuleSchema[],
): Promise<string[]> {
	if (modules.length === 0) return [];
	const applied = await appliedModuleMigrations(pool);
	return modules.flatMap((module) => {
		const done = new Set(applied[module.moduleId] ?? []);
		return module.migrations
			.filter((migration) => !done.has(migration.name))
			.map((migration) => `${module.moduleId}/${migration.name}`);
	});
}

/** Every Module migration the database has had, by Module, oldest first. */
export async function appliedModuleMigrations(pool: pg.Pool | pg.PoolClient): Promise<Record<string, string[]>> {
	const exists = await pool.query<{ found: string | null }>("SELECT to_regclass('public.module_migrations') AS found");
	const applied: Record<string, string[]> = {};
	if (!exists.rows[0]?.found) return applied;
	const rows = await pool.query<{ module_id: string; name: string }>(
		"SELECT module_id, name FROM public.module_migrations ORDER BY module_id, name",
	);
	for (const row of rows.rows) {
		const names = applied[row.module_id] ?? [];
		names.push(row.name);
		applied[row.module_id] = names;
	}
	return applied;
}

async function migrateModule(
	client: Client,
	module: ModuleSchema,
	partial: boolean,
	unit: MigrationUnit,
): Promise<string[]> {
	const { moduleId, schema } = module;
	const recorded = await client.query<{ name: string; checksum: string }>(
		"SELECT name, checksum FROM public.module_migrations WHERE module_id = $1",
		[moduleId],
	);
	const byName = new Map(module.migrations.map((migration) => [migration.name, migration]));
	const newest = module.migrations
		.map((migration) => migration.name)
		.sort()
		.at(-1);
	let ahead = false;
	for (const row of recorded.rows) {
		const migration = byName.get(row.name);
		if (!migration) {
			// A newer version of the Module applied it: the database is ahead of this build.
			if (!partial && (newest === undefined || row.name > newest)) {
				ahead = true;
				continue;
			}
			if (partial) continue;
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
	for (const [index, migration] of pending.entries()) {
		await client.query(unit.begin);
		try {
			const before = await outsideDigest(client, schema);
			await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
			const activity = await outsideActivity(client, schema);
			await client.query(`SET LOCAL search_path TO ${ident(schema)}, public`);
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
			await client.query("SET LOCAL search_path TO DEFAULT");
			const touched = touchedOutside(activity, await outsideActivity(client, schema));
			if (touched) {
				throw new ModuleMigrationError(
					`The Module ${moduleId}'s migration ${migration.name} ${touched.how} ${touched.table}, outside its own schema, ${schema}. A Module only reads and changes its own tables.`,
				);
			}
			if ((await outsideDigest(client, schema)) !== before) {
				throw new ModuleMigrationError(
					`The Module ${moduleId}'s migration ${migration.name} changed something outside its own schema, ${schema}. A Module only changes its own tables.`,
				);
			}
			// The last one is checked with everything the Module's migrations made together.
			if (!partial && index === pending.length - 1) await checkTables(client, module, ahead);
			await client.query(unit.commit);
		} catch (error) {
			await client.query(unit.rollback).catch(() => {});
			throw error;
		}
	}
	if (pending.length === 0 && !partial) await checkTables(client, module, ahead);
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

/**
 * What this transaction did so far to tables outside `schema`, by table: rows read and changed (the
 * transaction's own statistics), and the locks it holds (a `TRUNCATE` or `ALTER` changes no counted
 * row, but takes a lock). Compared before and after a Module's migrations.
 */
type Activity = Map<string, { reads: number; writes: number; locks: Set<string> }>;

async function outsideActivity(client: Client, schema: string): Promise<Activity> {
	const activity: Activity = new Map();
	const entry = (table: string) => {
		let found = activity.get(table);
		if (!found) {
			found = { reads: 0, writes: 0, locks: new Set() };
			activity.set(table, found);
		}
		return found;
	};
	const counts = await client.query<{ name: string; reads: string; writes: string }>(
		`SELECT schemaname || '.' || relname AS name,
				coalesce(seq_scan, 0) + coalesce(idx_scan, 0) AS reads,
				n_tup_ins + n_tup_upd + n_tup_del AS writes
			FROM pg_stat_xact_user_tables WHERE schemaname <> $1`,
		[schema],
	);
	for (const row of counts.rows)
		Object.assign(entry(row.name), { reads: Number(row.reads), writes: Number(row.writes) });
	const locks = await client.query<{ name: string; mode: string }>(
		`SELECT n.nspname || '.' || c.relname AS name, l.mode
			FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.granted AND c.relkind IN ('r', 'p')
				AND n.nspname <> $1 AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
		[schema],
	);
	for (const row of locks.rows) entry(row.name).locks.add(row.mode);
	return activity;
}

/** The tables a Module's foreign keys point at: reading them (and locking them, to add or drop a key) is how a key works. */
const REFERENCED_TABLES = new Set(["public.sites", "public.workspaces"]);

/** The Module migrations' own record, which the step itself writes. */
const MIGRATIONS_RECORD = "public.module_migrations";

/** Locks that only read. */
const READ_LOCKS = new Set(["AccessShareLock", "RowShareLock"]);

/** The first table outside its schema a Module's migrations changed or read, between two snapshots. */
function touchedOutside(before: Activity, after: Activity): { how: "changed" | "read"; table: string } | null {
	let read: string | null = null;
	for (const [table, now] of after) {
		if (table === MIGRATIONS_RECORD) continue;
		const then = before.get(table) ?? { reads: 0, writes: 0, locks: new Set<string>() };
		const newLocks = [...now.locks].filter((mode) => !then.locks.has(mode));
		// INSERT, UPDATE and DELETE take a row-exclusive lock even when they change no row; adding or
		// dropping a foreign key never does.
		if (now.writes > then.writes || newLocks.includes("RowExclusiveLock")) return { how: "changed", table };
		if (REFERENCED_TABLES.has(table)) continue;
		if (newLocks.some((mode) => !READ_LOCKS.has(mode))) return { how: "changed", table };
		if (read === null && (now.reads > then.reads || newLocks.length > 0)) read = table;
	}
	return read === null ? null : { how: "read", table: read };
}

/** Every relation in the Module's schema is a table it declares, following the tenant rule, with its declared columns. */
async function checkTables(client: Client, module: ModuleSchema, ahead: boolean): Promise<void> {
	const { moduleId, schema } = module;
	const refuse = (message: string): never => {
		throw new ModuleMigrationError(`The Module ${moduleId}: ${message}`);
	};
	const relations = await client.query<{ name: string; kind: string }>(
		`SELECT c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition`,
		[schema],
	);
	const declared = new Map(module.tables.map((table) => [table.name, table]));
	for (const relation of relations.rows) {
		if (relation.kind !== "r" && relation.kind !== "p" && !ahead)
			refuse(`${schema}.${relation.name} isn't a table; Modules keep tables only.`);
		// A newer version's migrations may have made tables this build doesn't know yet.
		if (!declared.has(relation.name) && !ahead)
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
		if (table.partitionedBy !== undefined) {
			const key = await client.query<{ strategy: string; columns: string[] }>(
				`SELECT p.partstrat AS strategy,
					(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(p.partattrs) WITH ORDINALITY k(attnum, ord)
						JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = k.attnum) AS columns
					FROM pg_partitioned_table p WHERE p.partrelid = $1::regclass`,
				[`${ident(schema)}.${ident(table.name)}`],
			);
			const [found] = key.rows;
			if (found?.strategy !== "r" || !same(found.columns, [table.partitionedBy])) {
				refuse(
					`${qualified} is kept in monthly partitions, so it must be made PARTITION BY RANGE (${table.partitionedBy}).`,
				);
			}
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
