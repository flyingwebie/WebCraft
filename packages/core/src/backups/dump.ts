import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type pg from "pg";
import { from as copyFrom, to as copyTo } from "pg-copy-streams";

import { type BackupManifest, PARTITION_BOUND } from "./manifest.ts";

/**
 * WebCraft writes a Backup's database dump itself, through `pg`, so web, worker and the CLI need no
 * `pg_dump` and any Postgres server works. The dump holds data only: the schema is the migrations,
 * so a restore first applies exactly the migrations the Backup's database had, then loads the rows.
 *
 * It covers WebCraft's tables (`public`) and every Module's schema (`m_<id>`), partitioned tables
 * with their partitions, and every sequence's value. Left out:
 * - the job queue (`pgboss`): waiting jobs aren't part of a Backup; a restore makes the queues
 *   again and queues what it can rebuild;
 * - the migration records (`drizzle`, `module_migrations`): the restore's migrations write them;
 * - `visitor_salts`: a day's salt must not outlive its day (Site analytics);
 * - `worker_heartbeats`: which workers run says something about now, never about a restored Install.
 */
export const LEFT_OUT_TABLES = new Set([
	"public.module_migrations",
	"public.visitor_salts",
	"public.worker_heartbeats",
]);

/** The schemas a Backup holds: WebCraft's own and the Modules'. */
const SCHEMAS_HELD = `(n.nspname = 'public' OR n.nspname LIKE 'm\\_%')`;

type DatabasePart = BackupManifest["database"];

/** One table's dump file, written by `dumpDatabase`. */
export type DumpFile = { file: string; path: string; size: number };

/**
 * Settings both ends of a dump use, as `pg_dump` does: times in UTC, ISO dates, every digit of a
 * float, so the text Postgres writes reads back as the same value.
 */
export async function useDumpSettings(client: pg.ClientBase): Promise<void> {
	await client.query("SET LOCAL TimeZone = 'UTC'");
	await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
	await client.query("SET LOCAL IntervalStyle = 'postgres'");
	await client.query("SET LOCAL extra_float_digits = 3");
}

/**
 * Dumps every table held into `folder` (one gzip-compressed COPY file each) inside the client's
 * open transaction, which must be a snapshot (`REPEATABLE READ`), so every table is read as of the
 * same moment. Answers the manifest's database part and the files.
 */
export async function dumpDatabase(
	client: pg.ClientBase,
	folder: string,
): Promise<{ database: DatabasePart; files: DumpFile[] }> {
	await useDumpSettings(client);
	const tables = await tablesInLoadOrder(client);
	const files: DumpFile[] = [];
	const dumped: DatabasePart["tables"] = [];
	for (const [index, table] of tables.entries()) {
		const file = `database/${String(index + 1).padStart(4, "0")}.copy.gz`;
		const path = join(folder, `${String(index + 1).padStart(4, "0")}.copy.gz`);
		const columns = table.columns.map(ident).join(", ");
		const copy = client.query(copyTo(`COPY (SELECT ${columns} FROM ${table.qualified}) TO STDOUT`));
		await pipeline(copy, createGzip(), createWriteStream(path));
		files.push({ file, path, size: (await stat(path)).size });
		dumped.push({ name: table.name, columns: table.columns, rows: copy.rowCount ?? 0, file });
	}
	return {
		database: {
			tables: dumped,
			sequences: await sequenceValues(client),
			partitions: await partitionsOf(client, tables),
		},
		files,
	};
}

/**
 * Loads one table's rows from its dump file's content, in the client's open transaction, into the
 * table the migrations made. Answers how many rows it loaded.
 */
export async function loadTable(
	client: pg.ClientBase,
	table: DatabasePart["tables"][number],
	content: AsyncIterable<Uint8Array>,
): Promise<number> {
	const columns = table.columns.map(ident).join(", ");
	const copy = client.query(copyFrom(`COPY ${qualifiedName(table.name)} (${columns}) FROM STDIN`));
	await pipeline(Readable.from(content), createGunzip(), copy);
	return copy.rowCount ?? 0;
}

/**
 * How many rows a table's dump file holds, read to its end without a database: COPY's text format
 * ends each row with a line feed and writes one inside a value as `\n`. Reading it whole also checks
 * the file itself, which gzip ends with a checksum of its content: a damaged one throws.
 */
export async function countDumpRows(content: AsyncIterable<Uint8Array>): Promise<number> {
	let rows = 0;
	await pipeline(Readable.from(content), createGunzip(), async (chunks: AsyncIterable<Buffer>) => {
		for await (const chunk of chunks) {
			for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) rows++;
		}
	});
	return rows;
}

/**
 * Makes the partitions a dump's partitioned tables had, before their rows are loaded. The statement is
 * built again from the bound's two timestamps, never from the manifest's text (`PARTITION_BOUND`).
 */
export async function makePartitions(client: pg.ClientBase, partitions: DatabasePart["partitions"]): Promise<void> {
	for (const partition of partitions) {
		const [, from, to] = PARTITION_BOUND.exec(partition.bound) ?? [];
		if (!from || !to) throw new Error(`The partition ${partition.name} has a bound WebCraft doesn't make.`);
		const [schema = "public"] = partition.parent.split(".");
		await client.query(
			`CREATE TABLE IF NOT EXISTS ${ident(schema)}.${ident(partition.name)} PARTITION OF ${qualifiedName(partition.parent)} FOR VALUES FROM (${literal(from)}) TO (${literal(to)})`,
		);
	}
}

/** Sets every sequence to the value it had when the dump was taken. */
export async function setSequences(client: pg.ClientBase, sequences: DatabasePart["sequences"]): Promise<void> {
	for (const sequence of sequences) {
		await client.query("SELECT setval($1::regclass, $2::bigint, $3)", [
			qualifiedName(sequence.name),
			sequence.value,
			sequence.called,
		]);
	}
}

/** Reads a dump file back as chunks (for writing it into an archive). */
export function readDumpFile(path: string): AsyncIterable<Uint8Array> {
	return createReadStream(path) as AsyncIterable<Uint8Array>;
}

type HeldTable = { name: string; qualified: string; columns: string[]; partitioned: boolean };

/** Every table held, ordered so a table comes after the tables its foreign keys point at. */
async function tablesInLoadOrder(client: pg.ClientBase): Promise<HeldTable[]> {
	const { rows } = await client.query<{ oid: number; name: string; kind: string; columns: string[] }>(
		`SELECT c.oid::int AS oid, n.nspname || '.' || c.relname AS name, c.relkind::text AS kind,
				array(SELECT a.attname::text FROM pg_attribute a
					WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
					ORDER BY a.attnum) AS columns
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${SCHEMAS_HELD}
			ORDER BY n.nspname, c.relname`,
	);
	const tables = rows.filter((row) => !LEFT_OUT_TABLES.has(row.name));
	const byOid = new Map(tables.map((table) => [table.oid, table]));
	const keys = await client.query<{ table: number; target: number }>(
		`SELECT con.conrelid::int AS "table", con.confrelid::int AS target FROM pg_constraint con
			WHERE con.contype = 'f' AND con.conrelid <> con.confrelid AND con.conparentid = 0`,
	);
	const pointsAt = new Map<number, number[]>();
	for (const key of keys.rows) {
		if (byOid.has(key.table) && byOid.has(key.target)) {
			pointsAt.set(key.table, [...(pointsAt.get(key.table) ?? []), key.target]);
		}
	}
	const ordered: typeof tables = [];
	const state = new Map<number, "visiting" | "done">();
	const visit = (table: (typeof tables)[number]) => {
		const seen = state.get(table.oid);
		if (seen === "done") return;
		if (seen === "visiting") {
			throw new Error(
				`The tables' foreign keys go round in a circle at ${table.name}, so they can't be loaded in order.`,
			);
		}
		state.set(table.oid, "visiting");
		for (const target of pointsAt.get(table.oid) ?? []) {
			const parent = byOid.get(target);
			if (parent) visit(parent);
		}
		state.set(table.oid, "done");
		ordered.push(table);
	};
	for (const table of tables) visit(table);
	return ordered.map((table) => ({
		name: table.name,
		qualified: qualifiedName(table.name),
		columns: table.columns,
		partitioned: table.kind === "p",
	}));
}

/** Every sequence of the schemas held (but those of tables left out), with its value. */
async function sequenceValues(client: pg.ClientBase): Promise<DatabasePart["sequences"]> {
	const { rows } = await client.query<{ name: string; owner: string | null }>(
		`SELECT n.nspname || '.' || c.relname AS name,
				(SELECT tn.nspname || '.' || t.relname FROM pg_depend d
					JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
					WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
						AND d.deptype IN ('a', 'i') LIMIT 1) AS owner
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE c.relkind = 'S' AND ${SCHEMAS_HELD}
			ORDER BY 1`,
	);
	const sequences: DatabasePart["sequences"] = [];
	for (const row of rows) {
		if (row.owner && LEFT_OUT_TABLES.has(row.owner)) continue;
		const value = await client.query<{ last_value: string; is_called: boolean }>(
			`SELECT last_value::text, is_called FROM ${qualifiedName(row.name)}`,
		);
		const [found] = value.rows;
		if (found) sequences.push({ name: row.name, value: found.last_value, called: found.is_called });
	}
	return sequences;
}

/** The partitions of the partitioned tables held, with their bounds. */
async function partitionsOf(client: pg.ClientBase, tables: HeldTable[]): Promise<DatabasePart["partitions"]> {
	const partitions: DatabasePart["partitions"] = [];
	for (const table of tables.filter((held) => held.partitioned)) {
		const { rows } = await client.query<{ name: string; bound: string }>(
			`SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
				FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
				WHERE i.inhparent = $1::regclass ORDER BY c.relname`,
			[table.qualified],
		);
		for (const row of rows) {
			// A restore makes only the monthly partitions WebCraft makes: refuse to write one it couldn't.
			if (!PARTITION_BOUND.test(row.bound)) {
				throw new Error(`The partition ${table.name}.${row.name} has a bound a restore can't make: ${row.bound}`);
			}
			partitions.push({ parent: table.name, name: row.name, bound: row.bound });
		}
	}
	return partitions;
}

/** `schema.table` as a quoted name. */
function qualifiedName(name: string): string {
	const dot = name.indexOf(".");
	return `${ident(name.slice(0, dot))}.${ident(name.slice(dot + 1))}`;
}

function ident(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
