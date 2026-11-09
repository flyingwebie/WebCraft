import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";
import { PgBoss, type Queue } from "pg-boss";

import { JOB_QUEUE_SCHEMA, JOB_QUEUE_SCHEMA_VERSION } from "./job-queue.ts";
import {
	appliedModuleMigrations,
	applyModuleMigrations,
	type ModuleSchema,
	pendingModuleMigrations,
} from "./module-migrations.ts";

/** What the migrate step and the schema check know besides WebCraft's own migrations: the Modules of this build. */
export type SchemaOptions = {
	/** The Modules whose migrations run after WebCraft's own (see `ModuleSchema`). */
	modules?: readonly ModuleSchema[];
};

/** A job queue the migrate step makes (or brings up to date): one per job of this build. */
export type JobQueueDefinition = { name: string; options?: Omit<Queue, "name"> };

export type MigrateOptions = SchemaOptions & {
	/**
	 * Every job queue of this build: the step makes the missing ones and brings the others' retry and
	 * expiry settings up to date, so a job sent before the worker ever started has a queue to wait in.
	 */
	queues?: readonly JobQueueDefinition[];
	/** This build's WebCraft version, recorded as the version that last migrated the database. */
	version?: string;
};

/** The folder `drizzle-kit generate` writes migrations to, one subfolder per migration. */
export const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

const MIGRATIONS_TABLE = "drizzle.__drizzle_migrations";

/** Only one migrate step changes a database at a time (a second one waits for the first). */
const MIGRATE_LOCK = "webcraft migrate step";

/**
 * What a database has had: WebCraft's own migrations, each Module's, and the job queue's schema
 * version (null when it isn't installed). A Backup records it as its migration level.
 */
export type MigrationLevel = {
	core: string[];
	modules: Record<string, string[]>;
	jobQueue: number | null;
};

export type MigrationReport = {
	/** The migrations this run applied, oldest first: WebCraft's own, then Modules' as `<module>/<name>`. */
	appliedMigrations: string[];
	/** The job queue schema version before the run (null when it wasn't installed) and after it. */
	jobQueueSchema: { from: number | null; to: number };
	/** The job queues this run made (the others existed and were brought up to date). */
	createdQueues: string[];
};

/** A migration failed: it was rolled back, and the ones before it stay applied. */
export class MigrationError extends Error {
	override name = "MigrationError";
}

/**
 * The `migrate` step (ADR 0031). Each pending migration runs in its own transaction: WebCraft's own
 * first, oldest first, then each Module's (in the order the build lists its Modules), each Module's
 * oldest first. A migration that fails is rolled back and stops the step; the ones before it stay
 * applied, which the previous WebCraft version still runs on (every migration keeps it working).
 * Then the job queue's schema is installed or upgraded, every job queue is made, and this build's
 * version is recorded. Web and worker never change the schema themselves.
 */
export async function runMigrations(databaseUrl: string, options: MigrateOptions = {}): Promise<MigrationReport> {
	const pool = migratePool(databaseUrl);
	const client = await pool.connect();
	try {
		await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATE_LOCK]);
		const before = await installedJobQueueVersion(client);
		assertJobQueueNotNewer(before);
		const core = await applyCoreMigrations(client);
		const modules = await applyModuleMigrations(client, options.modules ?? []);
		const createdQueues = await installJobQueue(databaseUrl, options.queues ?? []);
		if (options.version) await recordVersion(client, options.version);
		return {
			appliedMigrations: [...core, ...modules],
			jobQueueSchema: { from: before, to: JOB_QUEUE_SCHEMA_VERSION },
			createdQueues,
		};
	} finally {
		await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATE_LOCK]).catch(() => {});
		client.release();
		await pool.end();
	}
}

/**
 * Applies exactly the migrations of `level` (WebCraft's own and each Module's), each in its own
 * transaction, on an empty database: how a restore rebuilds the schema a Backup's data was taken
 * at. Refuses a level holding a migration this build doesn't have. The job queue isn't installed.
 */
export async function applyMigrationLevel(
	databaseUrl: string,
	level: Pick<MigrationLevel, "core" | "modules">,
	options: SchemaOptions = {},
): Promise<void> {
	const unknown = unknownMigrations(level, options);
	if (unknown.length > 0) {
		throw new MigrationError(`This version of WebCraft doesn't have the migrations ${unknown.join(", ")}.`);
	}
	const pool = migratePool(databaseUrl);
	const client = await pool.connect();
	try {
		await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATE_LOCK]);
		await applyCoreMigrations(client, new Set(level.core));
		const modules = (options.modules ?? []).map((module) => ({
			...module,
			migrations: module.migrations.filter((migration) => level.modules[module.moduleId]?.includes(migration.name)),
		}));
		await applyModuleMigrations(client, modules, { partial: true });
	} finally {
		await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATE_LOCK]).catch(() => {});
		client.release();
		await pool.end();
	}
}

/** The migrations of `level` this build doesn't have, as `<name>` or `<module>/<name>`. */
export function unknownMigrations(level: Pick<MigrationLevel, "core" | "modules">, options: SchemaOptions = {}) {
	const local = new Set(localMigrations().map((migration) => migration.name));
	const unknown = level.core.filter((name) => !local.has(name));
	const modules = new Map((options.modules ?? []).map((module) => [module.moduleId, module]));
	for (const [moduleId, names] of Object.entries(level.modules)) {
		const known = new Set(modules.get(moduleId)?.migrations.map((migration) => migration.name) ?? []);
		for (const name of names) if (!known.has(name)) unknown.push(`${moduleId}/${name}`);
	}
	return unknown;
}

/** What the database has had (see `MigrationLevel`). */
export async function readMigrationLevel(pool: pg.Pool | pg.PoolClient): Promise<MigrationLevel> {
	return {
		core: [...(await appliedMigrationNames(pool))],
		modules: await appliedModuleMigrations(pool),
		jobQueue: await installedJobQueueVersion(pool),
	};
}

/**
 * The WebCraft version whose migrate step last ran on the database: the version its data was
 * written by. Null when no migrate step recorded one (a database older than the record).
 */
export async function lastMigratedVersion(pool: pg.Pool | pg.PoolClient): Promise<string | null> {
	const exists = await pool.query<{ found: string | null }>("SELECT to_regclass('public.install_versions') AS found");
	if (!exists.rows[0]?.found) return null;
	const { rows } = await pool.query<{ version: string }>(
		"SELECT version FROM public.install_versions ORDER BY migrated_at DESC, version DESC LIMIT 1",
	);
	return rows[0]?.version ?? null;
}

function migratePool(databaseUrl: string): pg.Pool {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, application_name: "webcraft-migrate" });
	pool.on("error", () => {});
	return pool;
}

type LocalMigration = { name: string; hash: string; folderMillis: number; sql: string[] };

let cachedLocalMigrations: LocalMigration[] | undefined;

/** WebCraft's own migrations in this build, oldest first. */
function localMigrations(): LocalMigration[] {
	cachedLocalMigrations ??= readMigrationFiles({ migrationsFolder }).map((migration) => ({
		name: migration.name ?? "",
		hash: migration.hash,
		folderMillis: migration.folderMillis,
		sql: migration.sql,
	}));
	return cachedLocalMigrations;
}

/**
 * Applies WebCraft's pending migrations (or, given `only`, just those of them), oldest first, each
 * in its own transaction, recorded in Drizzle's table the way drizzle-kit records them. Answers
 * what it applied. Applied migrations this build doesn't have are left alone: the database is
 * ahead, after going back one version.
 */
async function applyCoreMigrations(client: pg.PoolClient, only?: ReadonlySet<string>): Promise<string[]> {
	await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
	await client.query(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
		id SERIAL PRIMARY KEY,
		hash text NOT NULL,
		created_at bigint,
		name text,
		applied_at timestamp with time zone DEFAULT now()
	)`);
	const applied = await appliedMigrationNames(client);
	const pending = localMigrations().filter(
		(migration) => !applied.has(migration.name) && (only === undefined || only.has(migration.name)),
	);
	for (const migration of pending) {
		await client.query("BEGIN");
		try {
			for (const statement of migration.sql) {
				if (statement.trim() !== "") await client.query(statement);
			}
			await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at, name) VALUES ($1, $2, $3)`, [
				migration.hash,
				migration.folderMillis,
				migration.name,
			]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw new MigrationError(
				`WebCraft's migration ${migration.name} failed, so it was rolled back (the migrations before it stay applied): ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
	return pending.map((migration) => migration.name);
}

/** Refuses a job queue schema newer than this build's: pg-boss can't run on it (see `checkSchema`). */
function assertJobQueueNotNewer(version: number | null): void {
	if (version !== null && version > JOB_QUEUE_SCHEMA_VERSION) {
		throw new DatabaseNotReadyError(jobQueueNewerMessage(version));
	}
}

function jobQueueNewerMessage(version: number): string {
	return `The job queue's schema is at version ${version}, newer than this version of WebCraft runs on (${JOB_QUEUE_SCHEMA_VERSION}): a newer WebCraft upgraded it, and the job queue can't go back. Run that newer version again, or restore the Backup the migrate step took before that update (see docs/deploy/README.md, "Going back a version").`;
}

/**
 * Installs or upgrades the job queue's schema, then makes every missing queue and brings the
 * others' settings up to date. Answers the queues it made.
 */
async function installJobQueue(databaseUrl: string, queues: readonly JobQueueDefinition[]): Promise<string[]> {
	const boss = new PgBoss({
		connectionString: databaseUrl,
		schema: JOB_QUEUE_SCHEMA,
		migrate: true,
		supervise: false,
		schedule: false,
		registerInstance: false,
		max: 1,
		application_name: "webcraft-migrate",
	});
	let failure: unknown;
	boss.on("error", (error) => {
		failure ??= error;
	});
	const created: string[] = [];
	try {
		await boss.start();
		for (const queue of queues) {
			if (await boss.getQueue(queue.name)) {
				const { policy: _policy, partition: _partition, ...settings } = queue.options ?? {};
				if (Object.keys(settings).length > 0) await boss.updateQueue(queue.name, settings);
			} else {
				await boss.createQueue(queue.name, queue.options);
				created.push(queue.name);
			}
		}
	} finally {
		await boss.stop({ graceful: false, close: true });
	}
	if (failure) throw failure;
	return created;
}

/** Records the WebCraft version that ran the migrate step (the table comes with this build's migrations). */
async function recordVersion(client: pg.PoolClient, version: string): Promise<void> {
	await client.query(
		`INSERT INTO public.install_versions (version, migrated_at) VALUES ($1, now())
			ON CONFLICT (version) DO UPDATE SET migrated_at = excluded.migrated_at`,
		[version],
	);
}

export type SchemaCheck =
	| { state: "current" }
	| {
			state: "behind";
			/** Migrations in this build that the database hasn't had yet. */
			pendingMigrations: string[];
			/** The installed job queue schema version, or null when it isn't installed. */
			jobQueueVersion: number | null;
			expectedJobQueueVersion: number;
	  }
	| {
			/** The job queue's schema is newer than this build's: the job queue can't run on it. */
			state: "job-queue-newer";
			jobQueueVersion: number;
			expectedJobQueueVersion: number;
	  }
	| { state: "unreachable"; error: Error };

/**
 * Compares the database with this build: is it reachable, and has it had every migration and the
 * job queue schema this build expects? A database whose migrations are ahead (after going back one
 * version) counts as current, because every schema change keeps the previous version working
 * (ADR 0031). The job queue is the exception: it refuses a schema newer than its own.
 */
export async function checkSchema(database: { pool: pg.Pool }, options: SchemaOptions = {}): Promise<SchemaCheck> {
	let state: SchemaState;
	try {
		state = await readSchemaState(database.pool, options);
	} catch (error) {
		return { state: "unreachable", error: error instanceof Error ? error : new Error(String(error)) };
	}
	if (state.jobQueueVersion !== null && state.jobQueueVersion > JOB_QUEUE_SCHEMA_VERSION) {
		return {
			state: "job-queue-newer",
			jobQueueVersion: state.jobQueueVersion,
			expectedJobQueueVersion: JOB_QUEUE_SCHEMA_VERSION,
		};
	}
	const jobQueueBehind = state.jobQueueVersion === null || state.jobQueueVersion < JOB_QUEUE_SCHEMA_VERSION;
	if (state.pendingMigrations.length === 0 && !jobQueueBehind) {
		return { state: "current" };
	}
	return {
		state: "behind",
		pendingMigrations: state.pendingMigrations,
		jobQueueVersion: state.jobQueueVersion,
		expectedJobQueueVersion: JOB_QUEUE_SCHEMA_VERSION,
	};
}

/** The database is behind this build, or can't be reached; the process must not start. */
export class DatabaseNotReadyError extends Error {
	override name = "DatabaseNotReadyError";
}

/** Refuses to go on unless the database is reachable and has had every migration (ADR 0031). */
export async function assertSchemaCurrent(database: { pool: pg.Pool }, options: SchemaOptions = {}): Promise<void> {
	const check = await checkSchema(database, options);
	if (check.state === "unreachable") {
		throw new DatabaseNotReadyError(`Cannot reach the database: ${check.error.message}`, {
			cause: check.error,
		});
	}
	if (check.state === "job-queue-newer") {
		throw new DatabaseNotReadyError(jobQueueNewerMessage(check.jobQueueVersion));
	}
	if (check.state === "behind") {
		const pending = [...check.pendingMigrations];
		if (check.jobQueueVersion !== check.expectedJobQueueVersion) {
			pending.push(`job queue schema ${check.jobQueueVersion ?? "(not installed)"} → ${check.expectedJobQueueVersion}`);
		}
		throw new DatabaseNotReadyError(
			`The database is behind this version of WebCraft. Run \`webcraft admin migrate\` first. Pending: ${pending.join(", ")}`,
		);
	}
}

type SchemaState = {
	pendingMigrations: string[];
	jobQueueVersion: number | null;
};

async function readSchemaState(pool: pg.Pool, options: SchemaOptions): Promise<SchemaState> {
	const applied = await appliedMigrationNames(pool);
	const modules = await pendingModuleMigrations(pool, options.modules ?? []);
	return {
		pendingMigrations: [
			...localMigrations()
				.map((migration) => migration.name)
				.filter((name) => !applied.has(name)),
			...modules,
		],
		jobQueueVersion: await installedJobQueueVersion(pool),
	};
}

async function appliedMigrationNames(pool: pg.Pool | pg.PoolClient): Promise<Set<string>> {
	const exists = await pool.query<{ found: string | null }>("SELECT to_regclass($1) AS found", [MIGRATIONS_TABLE]);
	if (!exists.rows[0]?.found) return new Set();
	const result = await pool.query<{ name: string | null }>(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
	return new Set(result.rows.flatMap((row) => (row.name ? [row.name] : [])));
}

async function installedJobQueueVersion(pool: pg.Pool | pg.PoolClient): Promise<number | null> {
	const table = `${JOB_QUEUE_SCHEMA}.version`;
	const exists = await pool.query<{ found: string | null }>("SELECT to_regclass($1) AS found", [table]);
	if (!exists.rows[0]?.found) return null;
	const result = await pool.query<{ version: number }>(`SELECT version FROM ${table}`);
	return result.rows[0]?.version ?? null;
}
