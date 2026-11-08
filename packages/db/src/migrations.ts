import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { PgBoss } from "pg-boss";

import { JOB_QUEUE_SCHEMA, JOB_QUEUE_SCHEMA_VERSION } from "./job-queue.ts";

/** The folder `drizzle-kit generate` writes migrations to, one subfolder per migration. */
export const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

export type MigrationReport = {
	/** The migrations this run applied, oldest first. */
	appliedMigrations: string[];
	/** The job queue schema version before the run (null when it wasn't installed) and after it. */
	jobQueueSchema: { from: number | null; to: number };
};

/**
 * The `migrate` step (ADR 0031): applies every pending migration in one transaction, then installs
 * or upgrades the job queue's schema. Web and worker never change the schema themselves.
 */
export async function runMigrations(databaseUrl: string): Promise<MigrationReport> {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, application_name: "webcraft-migrate" });
	pool.on("error", () => {});
	try {
		const before = await readSchemaState(pool);
		await migrate(drizzle({ client: pool }), {
			migrationsFolder,
			migrationsSchema: MIGRATIONS_SCHEMA,
			migrationsTable: MIGRATIONS_TABLE,
		});
		await installJobQueueSchema(databaseUrl);
		return {
			appliedMigrations: before.pendingMigrations,
			jobQueueSchema: { from: before.jobQueueVersion, to: JOB_QUEUE_SCHEMA_VERSION },
		};
	} finally {
		await pool.end();
	}
}

async function installJobQueueSchema(databaseUrl: string): Promise<void> {
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
	await boss.start();
	await boss.stop({ graceful: false, close: true });
	if (failure) throw failure;
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
	| { state: "unreachable"; error: Error };

/**
 * Compares the database with this build: is it reachable, and has it had every migration and the
 * job queue schema this build expects? A database that is ahead (after going back one version)
 * counts as current, because every schema change keeps the previous version working (ADR 0031).
 */
export async function checkSchema(database: { pool: pg.Pool }): Promise<SchemaCheck> {
	let state: SchemaState;
	try {
		state = await readSchemaState(database.pool);
	} catch (error) {
		return { state: "unreachable", error: error instanceof Error ? error : new Error(String(error)) };
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
export async function assertSchemaCurrent(database: { pool: pg.Pool }): Promise<void> {
	const check = await checkSchema(database);
	if (check.state === "unreachable") {
		throw new DatabaseNotReadyError(`Cannot reach the database: ${check.error.message}`, {
			cause: check.error,
		});
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

async function readSchemaState(pool: pg.Pool): Promise<SchemaState> {
	const applied = await appliedMigrationNames(pool);
	return {
		pendingMigrations: localMigrationNames().filter((name) => !applied.has(name)),
		jobQueueVersion: await installedJobQueueVersion(pool),
	};
}

let cachedLocalMigrationNames: string[] | undefined;

function localMigrationNames(): string[] {
	cachedLocalMigrationNames ??= readMigrationFiles({ migrationsFolder }).map((migration) => migration.name);
	return cachedLocalMigrationNames;
}

async function appliedMigrationNames(pool: pg.Pool): Promise<Set<string>> {
	const table = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;
	const exists = await pool.query<{ found: string | null }>("SELECT to_regclass($1) AS found", [table]);
	if (!exists.rows[0]?.found) return new Set();
	const result = await pool.query<{ name: string | null }>(`SELECT name FROM ${table}`);
	return new Set(result.rows.flatMap((row) => (row.name ? [row.name] : [])));
}

async function installedJobQueueVersion(pool: pg.Pool): Promise<number | null> {
	const table = `${JOB_QUEUE_SCHEMA}.version`;
	const exists = await pool.query<{ found: string | null }>("SELECT to_regclass($1) AS found", [table]);
	if (!exists.rows[0]?.found) return null;
	const result = await pool.query<{ version: number }>(`SELECT version FROM ${table}`);
	return result.rows[0]?.version ?? null;
}
