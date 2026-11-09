#!/usr/bin/env bun
// The `webcraft` command line. For now it has the server commands `admin migrate`, `backup`,
// `restore`, `check-update`, `rotate-key` and `create-superadmin`; the generated remote commands,
// `login` and the other server commands arrive with the CLI ticket.
import { readFile } from "node:fs/promises";
import { EmailInUseError, InvalidEmailError, PasswordRefusedError } from "@webcraft/auth";
import {
	BackupBusyError,
	BackupFailedError,
	CONFIRM_FINGERPRINT_LENGTH,
	ConfigError,
	FIRST_PARTY_MODULES,
	KeyRotationError,
	loadDatabaseUrl,
	loadMasterKey,
	MASTER_KEY_MIN_LENGTH,
	type MasterKey,
	MasterKeyMismatchError,
	moduleSchemas,
	OLD_MASTER_KEY_VARIABLE,
	parseMasterKey,
	RestoreRefusedError,
	replaceLostMasterKey,
	rotateMasterKey,
	SetupClosedError,
	systemClock,
} from "@webcraft/core";
import {
	assertSchemaCurrent,
	DatabaseNotReadyError,
	MigrationError,
	ModuleMigrationError,
	openDatabase,
} from "@webcraft/db";

import { backupCommand, checkUpdateCommand, migrateCommand, type RestoreOptions, restoreCommand } from "./backups.ts";
import { createSuperadmin, parseCreateSuperadminOptions } from "./create-superadmin.ts";

const USAGE = `Usage: webcraft <command>

Server commands (run on the server, with the Install's environment):
  admin migrate [--no-backup]
                     Apply pending database migrations, each in its own transaction, install or
                     upgrade the job queue schema and make its queues. Run it before starting a new
                     version of web and worker. When anything is pending on an Install, it first
                     takes a Backup (where Install settings › Backups says); --no-backup skips it.
  admin backup [--to <file or folder>]
                     Take a Backup now: one archive with the database, the files of local storage
                     (but Media variants, which are made again) and a manifest. It goes where Install
                     settings › Backups says, or to the file or folder given. It never holds the
                     Master key.
  admin restore <archive> [--force [--confirm <database name>]]
                     Restore a whole Install from a Backup into an empty database. Stop web and
                     worker first, and run it with the Master key the Install had then. --force
                     replaces everything in a database that isn't empty, once its name is typed
                     (asked on a terminal, or given with --confirm).
  admin check-update Read the release feed now and say whether a newer WebCraft is out.
  admin rotate-key [--old-key-file <path>]
                     Re-encrypt every secret under a new Master key. Stop web and worker first.
                     WEBCRAFT_SECRET_KEY holds the new key; the key being replaced comes from
                     WEBCRAFT_OLD_SECRET_KEY, or from the file given with --old-key-file.
  admin rotate-key --old-key-lost [--confirm-fingerprint <start of fingerprint>]
                     When the old key is lost: lists the secrets that can't be decrypted any more
                     and the lost key's fingerprint. Given the start of that fingerprint, deletes
                     them and starts using the key in WEBCRAFT_SECRET_KEY.
  admin create-superadmin <email> [--name <name>] [--language <en|it>]
                     Create the Superadmin of a fresh Install without the setup wizard, which then
                     closes. The password is asked twice on a terminal, or read from the first line
                     of standard input; it is never taken from the command line.

Options:
  -h, --help         Show this help.
`;

/** Errors whose message says everything: shown without a stack trace. */
const EXPLAINED_ERRORS = [
	ConfigError,
	DatabaseNotReadyError,
	KeyRotationError,
	MasterKeyMismatchError,
	MigrationError,
	ModuleMigrationError,
	RestoreRefusedError,
	BackupFailedError,
	BackupBusyError,
	SetupClosedError,
	PasswordRefusedError,
	InvalidEmailError,
	EmailInUseError,
];

async function main(args: string[]): Promise<number> {
	const [group, command, ...rest] = args;
	if (!group || group === "-h" || group === "--help" || group === "help") {
		process.stdout.write(USAGE);
		return group ? 0 : 1;
	}
	if (
		group === "admin" &&
		command === "migrate" &&
		(rest.length === 0 || (rest.length === 1 && rest[0] === "--no-backup"))
	) {
		return migrateCommand(process.env, { backup: rest.length === 0 });
	}
	if (group === "admin" && command === "backup") {
		const to = parseBackupOptions(rest);
		if (to !== null) return backupCommand(process.env, { to: to || undefined });
	}
	if (group === "admin" && command === "restore") {
		const options = parseRestoreOptions(rest);
		if (options) return restoreCommand(process.env, options);
	}
	if (group === "admin" && command === "check-update" && rest.length === 0) {
		return checkUpdateCommand(process.env);
	}
	if (group === "admin" && command === "rotate-key") {
		const options = parseRotateKeyOptions(rest);
		if (options) return rotateKey(options);
	}
	if (group === "admin" && command === "create-superadmin") {
		const options = parseCreateSuperadminOptions(rest);
		if (options) return createSuperadmin(options);
	}
	// Only the command is repeated: the rest could hold something secret typed in the wrong place.
	process.stderr.write(
		`Unknown command or options: webcraft ${[group, command].filter(Boolean).join(" ")}\n\n${USAGE}`,
	);
	return 1;
}

/** Reads `[--to <path>]`: the path, "" without one, null for anything else. */
function parseBackupOptions(args: string[]): string | null {
	if (args.length === 0) return "";
	const [flag, value, ...more] = args;
	if (more.length > 0) return null;
	if (flag === "--to" && value) return value;
	if (flag?.startsWith("--to=") && value === undefined && flag.length > 5) return flag.slice(5);
	return null;
}

/** Reads `<archive> [--force [--confirm <database name>]]`; null for anything else. */
function parseRestoreOptions(args: string[]): RestoreOptions | null {
	let archive: string | undefined;
	let force = false;
	let confirm: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--force") force = true;
		else if (arg === "--confirm" && args[index + 1]) confirm = args[++index];
		else if (arg.startsWith("--confirm=") && arg.length > 10) confirm = arg.slice(10);
		else if (!arg.startsWith("-") && archive === undefined) archive = arg;
		else return null;
	}
	if (archive === undefined || (confirm !== undefined && !force)) return null;
	return { archive, force, confirm };
}

type RotateKeyOptions = { oldKeyFile?: string; oldKeyLost: boolean; confirmFingerprint?: string };

/**
 * Reads `[--old-key-file <path> | --old-key-lost [--confirm-fingerprint <hex>]]`; null for
 * anything else.
 */
function parseRotateKeyOptions(args: string[]): RotateKeyOptions | null {
	const options: RotateKeyOptions = { oldKeyLost: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const value = (name: string): string | undefined => {
			if (arg === name && args[index + 1]) return args[++index];
			if (arg.startsWith(`${name}=`) && arg.length > name.length + 1) return arg.slice(name.length + 1);
			return undefined;
		};
		if (arg === "--old-key-lost") {
			options.oldKeyLost = true;
			continue;
		}
		const oldKeyFile = value("--old-key-file");
		if (oldKeyFile !== undefined) {
			options.oldKeyFile = oldKeyFile;
			continue;
		}
		const confirmFingerprint = value("--confirm-fingerprint");
		if (confirmFingerprint !== undefined) {
			options.confirmFingerprint = confirmFingerprint;
			continue;
		}
		return null;
	}
	return options.confirmFingerprint !== undefined && !options.oldKeyLost ? null : options;
}

async function rotateKey(options: RotateKeyOptions): Promise<number> {
	const databaseUrl = loadDatabaseUrl(process.env);
	const newKey = loadMasterKey(process.env);
	if (options.oldKeyLost) {
		if (options.oldKeyFile !== undefined || process.env[OLD_MASTER_KEY_VARIABLE]) {
			throw new ConfigError("--old-key-lost is for when the old key is lost; don't pass the old key with it.");
		}
		return replaceLostKey(databaseUrl, newKey, options.confirmFingerprint);
	}
	const oldKey = await loadOldKey(options);

	const database = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-rotate-key" });
	try {
		await assertSchemaCurrent(database, { modules: moduleSchemas(FIRST_PARTY_MODULES) });
		const report = await rotateMasterKey({
			database,
			from: oldKey.key,
			to: newKey,
			clock: systemClock,
			sources: { from: oldKey.source, to: "WEBCRAFT_SECRET_KEY" },
		});
		if (report.outcome === "already-current") {
			process.stdout.write(
				`The Install already uses this Master key (version ${report.version}); nothing was re-encrypted.\n`,
			);
			return 0;
		}
		process.stdout.write(
			`Re-encrypted ${countSecrets(report.reencrypted)} under Master key version ${report.version}.\n` +
				`Fingerprint of the new Master key: ${report.fingerprint}\n` +
				"Start web and worker with the new key in WEBCRAFT_SECRET_KEY, and keep a copy of it outside the server. The old key no longer opens anything.\n",
		);
		return 0;
	} finally {
		await database.close();
	}
}

async function replaceLostKey(
	databaseUrl: string,
	newKey: MasterKey,
	confirmFingerprint: string | undefined,
): Promise<number> {
	const database = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-rotate-key" });
	try {
		await assertSchemaCurrent(database, { modules: moduleSchemas(FIRST_PARTY_MODULES) });
		const report = await replaceLostMasterKey({ database, to: newKey, clock: systemClock, confirmFingerprint });
		const list = (secrets: string[]) => secrets.map((secret) => `  ${secret}\n`).join("");
		if (report.outcome === "needs-confirmation") {
			const confirm = report.lostFingerprint.slice(0, CONFIRM_FINGERPRINT_LENGTH);
			process.stdout.write(
				`Without the old Master key ${countSecrets(report.secrets.length, "these")} can't be decrypted, so they would be deleted:\n` +
					list(report.secrets) +
					`The Install's current Master key is version ${report.lostVersion}, fingerprint ${report.lostFingerprint}.\n` +
					"WEBCRAFT_SECRET_KEY is not that key. If you still have it, or mistyped the new key, stop here: use rotate-key with the old key instead.\n" +
					`If it is lost, run again with --confirm-fingerprint ${confirm} to delete these secrets and use the new key. Then set them again.\n`,
			);
			return 1;
		}
		process.stdout.write(
			`Deleted ${countSecrets(report.deleted.length)}. The Install now uses Master key version ${report.version}.\n` +
				`Fingerprint of the new Master key: ${report.fingerprint}\n` +
				(report.deleted.length > 0 ? `Set these secrets again:\n${list(report.deleted)}` : "") +
				"Start web and worker with the new key in WEBCRAFT_SECRET_KEY, and keep a copy of it outside the server.\n",
		);
		return 0;
	} finally {
		await database.close();
	}
}

/** "3 secrets", "1 secret", or with a word before the number: "these 3 secrets". */
function countSecrets(count: number, before?: string): string {
	const counted = `${count} secret${count === 1 ? "" : "s"}`;
	return before ? `${count === 1 ? "this" : before} ${counted}` : counted;
}

/** The key being replaced, from `--old-key-file` or `WEBCRAFT_OLD_SECRET_KEY` (not both). */
async function loadOldKey({ oldKeyFile }: RotateKeyOptions): Promise<{ key: MasterKey; source: string }> {
	const fromEnvironment = process.env[OLD_MASTER_KEY_VARIABLE];
	if (oldKeyFile !== undefined && fromEnvironment) {
		throw new ConfigError(
			`Give the key being replaced once: either in ${OLD_MASTER_KEY_VARIABLE} or with --old-key-file, not both.`,
		);
	}
	const source = oldKeyFile === undefined ? OLD_MASTER_KEY_VARIABLE : `the file ${oldKeyFile}`;
	let value = fromEnvironment;
	if (oldKeyFile !== undefined) {
		try {
			value = await readFile(oldKeyFile, "utf8");
		} catch (error) {
			throw new ConfigError(`Cannot read ${source}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!value?.trim()) {
		throw new ConfigError(
			`Pass the Install's current Master key, the one being replaced, in ${OLD_MASTER_KEY_VARIABLE} or with --old-key-file <path>. WEBCRAFT_SECRET_KEY holds the new key.`,
		);
	}
	try {
		return { key: parseMasterKey(value, source), source };
	} catch {
		throw new ConfigError(`${source} can't be a Master key: it is shorter than ${MASTER_KEY_MIN_LENGTH} characters.`);
	}
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		const explained = EXPLAINED_ERRORS.some((kind) => error instanceof kind);
		const message =
			explained && error instanceof Error ? error.message : error instanceof Error ? error.stack : String(error);
		process.stderr.write(`webcraft: ${message}\n`);
		process.exit(1);
	},
);
