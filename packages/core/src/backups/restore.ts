import { createReadStream } from "node:fs";
import {
	applyMigrationLevel,
	createBoss,
	type JobQueueOptions,
	type MigrationReport,
	type ModuleSchema,
	openDatabase,
	runMigrations,
	unknownMigrations,
} from "@webcraft/db";
import semver from "semver";
import { importsRun } from "../imports/runs.ts";
import { createJobQueue } from "../jobs/define.ts";
import { coreJobs } from "../jobs/index.ts";
import { jobQueues } from "../jobs/queues.ts";
import type { Logger } from "../log.ts";
import { mediaProcess, mediaVariants } from "../media/jobs.ts";
import { WEBCRAFT_VERSION } from "../version.ts";
import { loadTable, makePartitions, setSequences, useDumpSettings } from "./dump.ts";
import { FILES_FOLDER, restoreLocalFile } from "./files.ts";
import {
	BACKUP_FORMAT,
	BACKUP_FORMAT_VERSION,
	type BackupManifest,
	backupManifestSchema,
	MANIFEST_PATH,
} from "./manifest.ts";
import { readTar, TarFormatError } from "./tar.ts";

/** Why a restore didn't start. Nothing was changed. */
export type RestoreRefusal =
	| { reason: "not-a-backup"; detail: string }
	| { reason: "newer-version"; archive: string; running: string }
	| { reason: "newer-migrations"; migrations: string[] }
	| { reason: "master-key" }
	| { reason: "not-empty"; tables: number }
	| { reason: "in-use"; processes: string[] }
	| { reason: "confirmation"; expected: string };

/** A restore refused to start; the message says why and what to do. Nothing was changed. */
export class RestoreRefusedError extends Error {
	override name = "RestoreRefusedError";
	readonly refusal: RestoreRefusal;
	constructor(refusal: RestoreRefusal, message: string) {
		super(message);
		this.refusal = refusal;
	}
}

/** What restoring needs: the database to restore into, local storage, and this build's Modules. */
export type RestoreContext = {
	databaseUrl: string;
	storageDir: string;
	/** The running Master key's fingerprint, compared with the Backup's (ADR 0032). */
	fingerprint: string;
	/** The Modules of this build. */
	modules: readonly ModuleSchema[];
	log: Logger;
	/** Options for the job queue the restore queues work in (the test harness hands in its clock). */
	jobQueue?: JobQueueOptions;
};

export type RestoreOptions = {
	/**
	 * Restores into a database that holds something, deleting everything in it first: only with the
	 * database's name typed as `confirm`, so nobody replaces an Install by accident.
	 */
	replace?: { confirm: string };
	/** Hears each step as it starts, for the command's output. */
	onStep?(step: string): void;
};

export type RestoreReport = {
	manifest: BackupManifest;
	tables: number;
	rows: number;
	files: number;
	/** What the migrate step applied after the rows were in: the Backup was older than this build. */
	migrations: MigrationReport;
	/** Image variants queued to be made again, and uploads queued to be cleaned. */
	queued: { variants: number; uploads: number; imports: number };
};

/** What a database holds, before a restore: its name, how many tables, and who is connected to it. */
export type DatabaseContents = { name: string; tables: number; processes: string[] };

/** Reads a Backup's manifest, refusing a file that isn't a Backup this build can read. */
export async function readBackupManifest(archive: string): Promise<BackupManifest> {
	try {
		for await (const entry of readTar(openArchive(archive))) {
			return parseManifest(entry.path, await bytesOf(entry.body));
		}
	} catch (error) {
		if (error instanceof TarFormatError) throw notABackup(error.message.replace(/\.$/, "").toLowerCase());
		throw error;
	}
	throw notABackup("the archive is empty");
}

/** What the database a restore would go into holds. */
export async function inspectDatabase(databaseUrl: string): Promise<DatabaseContents> {
	const opened = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-restore" });
	const client = await opened.pool.connect();
	try {
		const { rows } = await client.query<{ name: string; tables: string }>(
			`SELECT current_database() AS name, (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
					AND n.nspname NOT LIKE 'pg\\_%')::text AS tables`,
		);
		const processes = await client.query<{ name: string }>(
			`SELECT DISTINCT application_name AS name FROM pg_stat_activity
				WHERE datname = current_database() AND pid <> pg_backend_pid()
					AND application_name IN ('webcraft-web', 'webcraft-worker') ORDER BY 1`,
		);
		return {
			name: rows[0]?.name ?? "",
			tables: Number(rows[0]?.tables ?? 0),
			processes: processes.rows.map((row) => row.name),
		};
	} finally {
		client.release();
		await opened.close();
	}
}

/**
 * Restores a whole Install from a Backup (ADRs 0032, 0033): never part of one, never into a
 * database that holds anything unless asked to replace it. It refuses a Backup a newer WebCraft
 * wrote, one with migrations this build doesn't have, and one taken under another Master key. Then
 * it rebuilds the schema the Backup was taken at, loads every row in one transaction, writes the
 * files back into local storage, runs the migrate step (a Backup of an older version is brought up
 * to this one), queues the image variants to be made again and clears every Site's page cache and
 * search index.
 */
export async function restoreBackup(
	context: RestoreContext,
	archive: string,
	options: RestoreOptions = {},
): Promise<RestoreReport> {
	const step = options.onStep ?? (() => {});
	const manifest = await readBackupManifest(archive);
	assertRestorable(manifest, context);
	const contents = await inspectDatabase(context.databaseUrl);
	if (contents.processes.length > 0) {
		throw new RestoreRefusedError(
			{ reason: "in-use", processes: contents.processes },
			`Web or worker is running on this database (${contents.processes.join(", ")}). Stop them first, then restore.`,
		);
	}
	if (contents.tables > 0) {
		if (!options.replace) {
			throw new RestoreRefusedError(
				{ reason: "not-empty", tables: contents.tables },
				`The database ${contents.name} isn't empty (it holds ${contents.tables} tables). Restore into an empty database, or replace everything in this one with --force.`,
			);
		}
		if (options.replace.confirm !== contents.name) {
			throw new RestoreRefusedError(
				{ reason: "confirmation", expected: contents.name },
				`To replace everything in the database, type its name, ${contents.name}, as the confirmation.`,
			);
		}
		step(`Deleting everything in the database ${contents.name}`);
		await emptyDatabase(context.databaseUrl);
	}

	step(`Rebuilding the database as it was (${manifest.migrations.core.length} migrations of WebCraft's)`);
	await applyMigrationLevel(context.databaseUrl, manifest.migrations, { modules: context.modules });

	const opened = openDatabase(context.databaseUrl, { maxConnections: 1, applicationName: "webcraft-restore" });
	const client = await opened.pool.connect();
	let rows = 0;
	let tables = 0;
	let files = 0;
	try {
		const tablesByFile = new Map(manifest.database.tables.map((table) => [table.file, table]));
		let loading = false;
		const finishLoading = async () => {
			if (!loading) return;
			await setSequences(client, manifest.database.sequences);
			await client.query("COMMIT");
			loading = false;
		};
		try {
			let first = true;
			for await (const entry of readTar(openArchive(archive))) {
				if (first) {
					first = false;
					step(`Loading ${manifest.database.tables.length} tables`);
					await client.query("BEGIN");
					loading = true;
					await useDumpSettings(client);
					await makePartitions(client, manifest.database.partitions);
					continue;
				}
				const table = tablesByFile.get(entry.path);
				if (table) {
					rows += await loadTable(client, table, entry.body);
					tables++;
					continue;
				}
				if (entry.path.startsWith(FILES_FOLDER)) {
					if (loading) {
						await finishLoading();
						step(`Writing ${manifest.files.local.count} files into local storage`);
					}
					await restoreLocalFile(context.storageDir, entry.path.slice(FILES_FOLDER.length), entry.body);
					files++;
				}
			}
			await finishLoading();
		} catch (error) {
			if (loading) await client.query("ROLLBACK").catch(() => {});
			if (error instanceof TarFormatError) throw notABackup(error.message.replace(/\.$/, "").toLowerCase());
			throw error;
		}
	} finally {
		client.release();
		await opened.close();
	}
	if (tables !== manifest.database.tables.length) {
		throw notABackup(`it holds ${tables} of the ${manifest.database.tables.length} tables its manifest lists`);
	}

	step("Running the migrate step");
	const migrations = await runMigrations(context.databaseUrl, {
		modules: context.modules,
		queues: jobQueues(coreJobs),
		version: WEBCRAFT_VERSION,
	});
	step("Queueing image variants and clearing caches");
	const queued = await afterRestore(context.databaseUrl, manifest, context.jobQueue);
	context.log.info("Restored a Backup", {
		archive,
		createdAt: manifest.createdAt,
		tables,
		rows,
		files,
		migrations: migrations.appliedMigrations,
	});
	return { manifest, tables, rows, files, migrations, queued };
}

/** Refuses a Backup this build can't restore: newer, with migrations it lacks, or under another Master key. */
function assertRestorable(manifest: BackupManifest, context: RestoreContext): void {
	const archive = manifest.webcraft.version;
	if (semver.valid(archive) && semver.valid(WEBCRAFT_VERSION) && semver.gt(archive, WEBCRAFT_VERSION)) {
		throw new RestoreRefusedError(
			{ reason: "newer-version", archive, running: WEBCRAFT_VERSION },
			`The Backup was taken from WebCraft ${archive}, newer than this one (${WEBCRAFT_VERSION}). Restore it with WebCraft ${archive} or later.`,
		);
	}
	const unknown = unknownMigrations(manifest.migrations, { modules: context.modules });
	if (unknown.length > 0) {
		throw new RestoreRefusedError(
			{ reason: "newer-migrations", migrations: unknown },
			`The Backup's database had migrations this version of WebCraft doesn't have (${unknown.join(", ")}): it comes from a newer version. Restore it with that version or later.`,
		);
	}
	if (manifest.masterKey.fingerprint !== context.fingerprint) {
		throw new RestoreRefusedError(
			{ reason: "master-key" },
			`The Backup was taken under another Master key (fingerprint ${manifest.masterKey.fingerprint.slice(0, 12)}…; WEBCRAFT_SECRET_KEY's is ${context.fingerprint.slice(0, 12)}…). Start with the Master key the Install had then: it is never in a Backup.`,
		);
	}
}

/** Deletes every table, sequence, function and type of the database's own schemas, and its other schemas. */
async function emptyDatabase(databaseUrl: string): Promise<void> {
	const opened = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-restore" });
	const client = await opened.pool.connect();
	try {
		await client.query("BEGIN");
		const schemas = await client.query<{ name: string }>(
			`SELECT nspname AS name FROM pg_namespace WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
				AND nspname NOT LIKE 'pg\\_%'`,
		);
		for (const { name } of schemas.rows) await client.query(`DROP SCHEMA ${ident(name)} CASCADE`);
		const drop = async (kind: string, query: string) => {
			for (const { name } of (await client.query<{ name: string }>(query)).rows) {
				await client.query(`DROP ${kind} IF EXISTS ${name} CASCADE`);
			}
		};
		await drop(
			"TABLE",
			"SELECT format('public.%I', c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition",
		);
		await drop(
			"VIEW",
			"SELECT format('public.%I', c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'v'",
		);
		await drop(
			"MATERIALIZED VIEW",
			"SELECT format('public.%I', c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'm'",
		);
		await drop(
			"SEQUENCE",
			"SELECT format('public.%I', c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S'",
		);
		await drop(
			"ROUTINE",
			"SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')",
		);
		await drop(
			"TYPE",
			"SELECT format('public.%I', t.typname) AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c', 'r', 'm') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid) AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')",
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
		await opened.close();
	}
}

/**
 * After the rows are in and the schema is current: the Media variants a Backup leaves out are made
 * again (pages show originals until then), uploads that were waiting to be cleaned and Import runs
 * that were under way are queued again, and every Site's page cache and search index start over.
 */
async function afterRestore(
	databaseUrl: string,
	manifest: BackupManifest,
	jobQueue: JobQueueOptions = {},
): Promise<RestoreReport["queued"]> {
	const opened = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-restore" });
	const client = await opened.pool.connect();
	let variants: { site_id: string; media_id: string }[];
	let uploads: { site_id: string; media_id: string }[];
	let runs: { site_id: string; id: string }[];
	try {
		await client.query("BEGIN");
		await client.query("DELETE FROM public.media_files WHERE role = 'variant' AND storage = 'disk'");
		variants = (
			await client.query<{ site_id: string; media_id: string }>(
				`SELECT DISTINCT f.site_id::text, f.media_id::text FROM public.media_files f
					WHERE f.role = 'original' AND f.retired_at IS NULL AND f.format <> 'svg' AND f.width IS NOT NULL
						AND NOT EXISTS (SELECT 1 FROM public.media_files v
							WHERE v.media_id = f.media_id AND v.role = 'variant' AND v.retired_at IS NULL)`,
			)
		).rows;
		uploads = (
			await client.query<{ site_id: string; media_id: string }>(
				"SELECT DISTINCT site_id::text, media_id::text FROM public.media_files WHERE role = 'upload'",
			)
		).rows;
		runs = (
			await client.query<{ site_id: string; id: string }>(
				"SELECT site_id::text, id::text FROM public.import_runs WHERE status IN ('waiting', 'running')",
			)
		).rows;
		await client.query(
			"UPDATE public.sites SET page_cache_generation = page_cache_generation + 1, search_index_version = 0, search_rebuild_claimed_at = NULL",
		);
		// The Backup log was copied while this Backup was being written: it finished, as the archive shows.
		await client.query(
			"UPDATE public.backups SET status = 'done', finished_at = $2 WHERE status = 'running' AND name = $1",
			[manifest.name, manifest.createdAt],
		);
		await client.query(
			"UPDATE public.backups SET status = 'failed', finished_at = $1, problem = 'It was still being taken when the Backup this Install was restored from was taken.' WHERE status = 'running'",
			[manifest.createdAt],
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
		await opened.close();
	}
	const boss = createBoss(databaseUrl, {
		...jobQueue,
		supervise: false,
		schedule: false,
		registerInstance: false,
		max: 1,
		application_name: "webcraft-restore",
	});
	boss.on("error", () => {});
	await boss.start();
	try {
		const jobs = createJobQueue(boss);
		for (const row of variants) await jobs.send(mediaVariants, { siteId: row.site_id, mediaId: row.media_id });
		for (const row of uploads) await jobs.send(mediaProcess, { siteId: row.site_id, mediaId: row.media_id });
		for (const row of runs) await jobs.send(importsRun, { siteId: row.site_id, runId: row.id });
	} finally {
		await boss.stop({ graceful: false, close: true });
	}
	return { variants: variants.length, uploads: uploads.length, imports: runs.length };
}

function parseManifest(path: string, bytes: Uint8Array): BackupManifest {
	if (path !== MANIFEST_PATH) throw notABackup(`its first file is ${path}, not ${MANIFEST_PATH}`);
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw notABackup("its manifest isn't JSON");
	}
	const format = json as { format?: unknown; formatVersion?: unknown };
	if (format.format !== BACKUP_FORMAT) throw notABackup("its manifest isn't a WebCraft Backup's");
	if (typeof format.formatVersion === "number" && format.formatVersion > BACKUP_FORMAT_VERSION) {
		throw new RestoreRefusedError(
			{ reason: "not-a-backup", detail: "newer format" },
			`The Backup was written in a newer format (${format.formatVersion}) than this version of WebCraft reads (${BACKUP_FORMAT_VERSION}). Restore it with a newer WebCraft.`,
		);
	}
	const parsed = backupManifestSchema.safeParse(json);
	if (!parsed.success) throw notABackup("its manifest is incomplete");
	return parsed.data;
}

function notABackup(detail: string): RestoreRefusedError {
	return new RestoreRefusedError(
		{ reason: "not-a-backup", detail },
		`That file isn't a WebCraft Backup this version can read: ${detail}.`,
	);
}

function openArchive(path: string): AsyncIterable<Uint8Array> {
	const stream = createReadStream(path);
	return {
		async *[Symbol.asyncIterator]() {
			try {
				for await (const chunk of stream as AsyncIterable<Uint8Array>) yield chunk;
			} catch (error) {
				if ((error as { code?: unknown }).code === "ENOENT") throw notABackup(`there is no file at ${path}`);
				throw error;
			} finally {
				stream.destroy();
			}
		},
	};
}

async function bytesOf(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of body) chunks.push(chunk);
	const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.length;
	}
	return joined;
}

function ident(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}
