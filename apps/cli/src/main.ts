#!/usr/bin/env bun
// The `webcraft` command line. For now it has the server commands `admin migrate`,
// `admin rotate-key` and `admin create-superadmin`; the generated remote commands, `login` and the
// other server commands arrive with the CLI ticket.
import { readFile } from "node:fs/promises";
import { EmailInUseError, InvalidEmailError, PasswordRefusedError } from "@webcraft/auth";
import {
	ConfigError,
	KeyRotationError,
	loadDatabaseUrl,
	loadMasterKey,
	MASTER_KEY_MIN_LENGTH,
	type MasterKey,
	MasterKeyMismatchError,
	OLD_MASTER_KEY_VARIABLE,
	parseMasterKey,
	replaceLostMasterKey,
	rotateMasterKey,
	SetupClosedError,
	systemClock,
} from "@webcraft/core";
import { assertSchemaCurrent, DatabaseNotReadyError, openDatabase, runMigrations } from "@webcraft/db";

import { createSuperadmin, parseCreateSuperadminOptions } from "./create-superadmin.ts";

const USAGE = `Usage: webcraft <command>

Server commands (run on the server, with the Install's environment):
  admin migrate      Apply pending database migrations and install or upgrade the job queue schema.
                     Run it before starting a new version of web and worker.
  admin rotate-key [--old-key-file <path>]
                     Re-encrypt every secret under a new Master key. Stop web and worker first.
                     WEBCRAFT_SECRET_KEY holds the new key; the key being replaced comes from
                     WEBCRAFT_OLD_SECRET_KEY, or from the file given with --old-key-file.
  admin rotate-key --old-key-lost [--yes]
                     When the old key is lost: lists the secrets that can't be decrypted any more,
                     and with --yes deletes them and starts using the key in WEBCRAFT_SECRET_KEY.
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
	if (group === "admin" && command === "migrate" && rest.length === 0) {
		return migrate();
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

async function migrate(): Promise<number> {
	const report = await runMigrations(loadDatabaseUrl(process.env));
	const applied = report.appliedMigrations;
	process.stdout.write(
		applied.length === 0
			? "No migrations were pending.\n"
			: `Applied ${applied.length} migration${applied.length === 1 ? "" : "s"}:\n${applied.map((name) => `  ${name}\n`).join("")}`,
	);
	const { from, to } = report.jobQueueSchema;
	process.stdout.write(
		from === to
			? `The job queue schema is at version ${to}.\n`
			: `The job queue schema went from ${from === null ? "not installed" : `version ${from}`} to version ${to}.\n`,
	);
	return 0;
}

type RotateKeyOptions = { oldKeyFile?: string; oldKeyLost: boolean; yes: boolean };

/** Reads `[--old-key-file <path> | --old-key-lost [--yes]]`; null for anything else. */
function parseRotateKeyOptions(args: string[]): RotateKeyOptions | null {
	const options: RotateKeyOptions = { oldKeyLost: false, yes: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--old-key-lost") options.oldKeyLost = true;
		else if (arg === "--yes") options.yes = true;
		else if (arg === "--old-key-file" && args[index + 1]) options.oldKeyFile = args[++index];
		else if (arg.startsWith("--old-key-file=") && arg.length > "--old-key-file=".length) {
			options.oldKeyFile = arg.slice("--old-key-file=".length);
		} else return null;
	}
	return options.yes && !options.oldKeyLost ? null : options;
}

async function rotateKey(options: RotateKeyOptions): Promise<number> {
	const databaseUrl = loadDatabaseUrl(process.env);
	const newKey = loadMasterKey(process.env);
	if (options.oldKeyLost) {
		if (options.oldKeyFile !== undefined || process.env[OLD_MASTER_KEY_VARIABLE]) {
			throw new ConfigError("--old-key-lost is for when the old key is lost; don't pass the old key with it.");
		}
		return replaceLostKey(databaseUrl, newKey, options.yes);
	}
	const oldKey = await loadOldKey(options);

	const database = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-rotate-key" });
	try {
		await assertSchemaCurrent(database);
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

async function replaceLostKey(databaseUrl: string, newKey: MasterKey, confirmed: boolean): Promise<number> {
	const database = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-rotate-key" });
	try {
		await assertSchemaCurrent(database);
		const report = await replaceLostMasterKey({ database, to: newKey, clock: systemClock, confirmed });
		const list = (secrets: string[]) => secrets.map((secret) => `  ${secret}\n`).join("");
		if (report.outcome === "needs-confirmation") {
			process.stdout.write(
				`Without the old Master key ${countSecrets(report.secrets.length, "these")} can't be decrypted, so they would be deleted:\n` +
					list(report.secrets) +
					"Run again with --yes to delete them and use the new key. Then set them again.\n",
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
