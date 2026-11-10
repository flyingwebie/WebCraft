import {
	type BackupManifest,
	ConfigError,
	createLogger,
	type Environment,
	FIRST_PARTY_MODULES,
	inspectDatabase,
	type Logger,
	loadInstallConfig,
	loadMasterKey,
	type MigrateStepReport,
	migrateStep,
	moduleSchemas,
	openBackupForCommand,
	openInstallForCommand,
	readBackupManifest,
	restoreBackup,
	type TakenBackup,
	takeBackup,
} from "@webcraft/core";
import { createBunHttp } from "@webcraft/server/outgoing-http";

import { ask, interactive } from "./prompt.ts";

/** Logs go to standard error as JSON lines, so the Install's log keeps a record of what the command did. */
function commandLog(): Logger {
	return createLogger({
		fields: { process: "cli" },
		write: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
	});
}

/** Takes a Backup with what the Install's environment gives, closing the database afterwards. */
async function backUp(env: Environment, options: { reason: "command" | "before-migrations"; to?: string }) {
	const { context, close } = await openBackupForCommand({ env, log: commandLog(), http: createBunHttp() });
	try {
		return await takeBackup(context, options);
	} finally {
		await close();
	}
}

/** `webcraft admin backup [--to <file or folder>]`. */
export async function backupCommand(env: Environment, options: { to?: string }): Promise<number> {
	const taken = await backUp(env, { reason: "command", to: options.to });
	process.stdout.write(
		`Took a Backup: ${taken.location} (${size(taken.sizeBytes)}).\n${describe(taken.manifest)}` +
			"It holds no Master key: keep WEBCRAFT_SECRET_KEY somewhere else, a restore needs it.\n",
	);
	return 0;
}

/** `webcraft admin migrate [--no-backup]`. */
export async function migrateCommand(env: Environment, options: { backup: boolean }): Promise<number> {
	const report = await migrateStep({
		databaseUrl: loadDatabaseUrlOnly(env),
		modules: FIRST_PARTY_MODULES,
		takeBackup: options.backup ? () => backUpBeforeMigrations(env) : null,
	});
	process.stdout.write(migrateReport(report));
	return 0;
}

/**
 * The Backup the migrate step takes first. It reads the same settings as web and worker; without
 * them it says how to go on.
 */
async function backUpBeforeMigrations(env: Environment): Promise<TakenBackup> {
	try {
		return await backUp(env, { reason: "before-migrations" });
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		throw new ConfigError(
			`Migrations are pending, so the migrate step takes a Backup first, which needs the Install's settings: ${error.message} Give the migrate step the same environment as web and worker (and the storage and Backups volumes), or run \`webcraft admin migrate --no-backup\` to go on without a Backup.`,
		);
	}
}

/** The migrate step needs only `DATABASE_URL`, unless it takes a Backup (which reads the rest). */
function loadDatabaseUrlOnly(env: Environment): string {
	const value = env.DATABASE_URL?.trim();
	if (!value) {
		throw new ConfigError(
			"DATABASE_URL is not set. Set it to the Install's Postgres connection string, for example postgres://user:password@host:5432/webcraft.",
		);
	}
	return value;
}

function migrateReport(report: MigrateStepReport): string {
	const lines: string[] = [];
	switch (report.backup.state) {
		case "taken":
			lines.push(`Took a Backup first: ${report.backup.backup.location} (${size(report.backup.backup.sizeBytes)}).`);
			break;
		case "skipped":
			lines.push("Took no Backup first (--no-backup), although migrations were pending.");
			break;
		default:
			if (report.backup.reason === "new-database") lines.push("The database is new: there was nothing to back up.");
	}
	const applied = report.appliedMigrations;
	lines.push(
		applied.length === 0
			? "No migrations were pending."
			: `Applied ${applied.length} migration${applied.length === 1 ? "" : "s"}, each in its own transaction:\n${applied.map((name) => `  ${name}`).join("\n")}`,
	);
	const { from, to } = report.jobQueueSchema;
	lines.push(
		from === to
			? `The job queue schema is at version ${to}.`
			: `The job queue schema went from ${from === null ? "not installed" : `version ${from}`} to version ${to}.${from === null ? "" : " Going back to the previous WebCraft version now means restoring the Backup taken before this step."}`,
	);
	if (report.createdQueues.length > 0) {
		lines.push(`Made ${report.createdQueues.length} job queue${report.createdQueues.length === 1 ? "" : "s"}.`);
	}
	return `${lines.join("\n")}\n`;
}

export type RestoreOptions = { archive: string; force: boolean; confirm?: string };

/** `webcraft admin restore <archive> [--force [--confirm <database name>]]`. */
export async function restoreCommand(env: Environment, options: RestoreOptions): Promise<number> {
	const config = loadInstallConfig(env);
	const masterKey = loadMasterKey(env);
	const manifest = await readBackupManifest(options.archive);
	process.stdout.write(describe(manifest));
	let replace: { confirm: string } | undefined;
	if (options.force) {
		const contents = await inspectDatabase(config.databaseUrl);
		if (contents.tables > 0) {
			const confirm =
				options.confirm ??
				(interactive()
					? await ask(
							`This deletes everything in the database ${contents.name} (${contents.tables} tables) and puts the Backup in its place. Type the database's name to go on: `,
						)
					: undefined);
			if (!confirm?.trim()) {
				throw new ConfigError(
					`Restoring over the database ${contents.name} deletes everything in it. Type its name when asked, or pass --confirm ${contents.name}.`,
				);
			}
			replace = { confirm: confirm.trim() };
		}
	}
	const report = await restoreBackup(
		{
			databaseUrl: config.databaseUrl,
			storageDir: config.storageDir,
			fingerprint: await masterKey.fingerprint(),
			modules: moduleSchemas(FIRST_PARTY_MODULES),
			log: commandLog(),
		},
		options.archive,
		{ replace, onStep: (step) => process.stdout.write(`${step}…\n`) },
	);
	const applied = report.migrations.appliedMigrations;
	process.stdout.write(
		`Restored ${report.rows} rows in ${report.tables} tables and ${report.files} files.\n` +
			(applied.length > 0
				? `The Backup was older than this version: the migrate step applied ${applied.length} migration${applied.length === 1 ? "" : "s"}.\n`
				: "") +
			`Queued ${report.queued.variants} image${report.queued.variants === 1 ? "" : "s"} to have their variants made again; pages show the originals until the worker has made them.\n` +
			"Every Site's page cache and search index start over. Start web and worker.\n",
	);
	return 0;
}

/** `webcraft admin check-update`. */
export async function checkUpdateCommand(env: Environment): Promise<number> {
	const services = await openInstallForCommand({ env, log: commandLog(), http: createBunHttp() });
	try {
		const check = await services.updates.check();
		if (!check.enabled) {
			process.stdout.write(`The update check is off (WEBCRAFT_UPDATE_FEED=off). This is WebCraft ${check.running}.\n`);
			return 0;
		}
		if (check.problem && !check.latest) {
			process.stdout.write(
				`The release feed couldn't be read (${check.problem}). This is WebCraft ${check.running}.\n`,
			);
			return 1;
		}
		const latest = check.latest;
		process.stdout.write(
			check.updateAvailable && latest
				? `WebCraft ${latest.version} is available; this is ${check.running}.${latest.url ? `\nRelease notes: ${latest.url}` : ""}\n`
				: `This is WebCraft ${check.running}, the newest release${latest ? ` (${latest.version})` : ""}.\n`,
		);
		if (check.problem)
			process.stdout.write(`(The feed couldn't be read just now: ${check.problem}. That is from the last check.)\n`);
		return 0;
	} finally {
		await services.database.close();
	}
}

/** One line about a Backup: when, why, which WebCraft, and what it holds. */
function describe(manifest: BackupManifest): string {
	const reasons = {
		scheduled: "scheduled",
		command: "taken by command",
		"before-migrations": "taken before migrations",
	};
	const rows = manifest.database.tables.reduce((sum, table) => sum + table.rows, 0);
	const bucket = manifest.files.bucket
		? ` Files in the bucket ${manifest.files.bucket.bucket} (${manifest.files.bucket.files}) aren't in it: they stay in the bucket.`
		: "";
	return `Backup of ${manifest.createdAt} (${reasons[manifest.reason]}), WebCraft ${manifest.webcraft.version}: ${rows} rows in ${manifest.database.tables.length} tables, ${manifest.files.local.count} files.${bucket}\n`;
}

function size(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export type { TakenBackup };
