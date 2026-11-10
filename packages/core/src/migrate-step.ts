import {
	checkSchema,
	DatabaseNotReadyError,
	type MigrationReport,
	openDatabase,
	readMigrationLevel,
	runMigrations,
} from "@webcraft/db";
import type { AnyModuleDefinition } from "@webcraft/module-sdk";

import type { TakenBackup } from "./backups/take.ts";
import { coreJobs } from "./jobs/index.ts";
import { jobQueues } from "./jobs/queues.ts";
import { FIRST_PARTY_MODULES } from "./modules/first-party.ts";
import { moduleSchemas } from "./modules/schemas.ts";
import { WEBCRAFT_VERSION } from "./version.ts";

/** What the migrate step did about a Backup before changing anything. */
export type MigrateBackup =
	| { state: "taken"; backup: TakenBackup }
	/** `--no-backup`: migrations were pending, and the step went on without one. */
	| { state: "skipped" }
	/** Nothing was pending, or the database was new (nothing in it to back up). */
	| { state: "not-needed"; reason: "nothing-pending" | "new-database" };

export type MigrateStepReport = MigrationReport & { backup: MigrateBackup };

/**
 * The `migrate` step (ADR 0031), as `webcraft admin migrate` runs it: when anything is pending
 * (WebCraft's migrations, a Module's, the job queue's schema) on a database that already holds an
 * Install, it first takes a Backup (`takeBackup`; null skips it, for `--no-backup`), so a failed or
 * regretted update can be undone by restoring it. Then each migration runs in its own transaction,
 * every job queue is made and this build's version is recorded (see `runMigrations`).
 */
export async function migrateStep(options: {
	databaseUrl: string;
	modules?: readonly AnyModuleDefinition[];
	takeBackup: (() => Promise<TakenBackup>) | null;
}): Promise<MigrateStepReport> {
	const modules = moduleSchemas(options.modules ?? FIRST_PARTY_MODULES);
	const database = openDatabase(options.databaseUrl, { maxConnections: 1, applicationName: "webcraft-migrate" });
	let backup: MigrateBackup;
	try {
		const check = await checkSchema(database, { modules });
		if (check.state === "unreachable") {
			throw new DatabaseNotReadyError(`Cannot reach the database: ${check.error.message}`, { cause: check.error });
		}
		const level = await readMigrationLevel(database.pool);
		if (check.state !== "behind") backup = { state: "not-needed", reason: "nothing-pending" };
		else if (level.core.length === 0) backup = { state: "not-needed", reason: "new-database" };
		else if (options.takeBackup === null) backup = { state: "skipped" };
		else backup = { state: "taken", backup: await options.takeBackup() };
	} finally {
		await database.close();
	}
	const report = await runMigrations(options.databaseUrl, {
		modules,
		queues: jobQueues(coreJobs),
		version: WEBCRAFT_VERSION,
	});
	return { ...report, backup };
}
