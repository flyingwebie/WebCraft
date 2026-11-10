// The server commands, `webcraft admin …`: run on the server with the Install's environment
// (`DATABASE_URL`, `WEBCRAFT_ADMIN_HOST`, `WEBCRAFT_SECRET_KEY`, …), from the web image or a checkout.
// Loaded only when an `admin` command runs, so the remote commands never load the Install's code.
import { EmailInUseError, InvalidEmailError, PasswordRefusedError } from "@webcraft/auth";
import {
	BackupBusyError,
	BackupFailedError,
	ConfigError,
	KeyRotationError,
	MasterKeyMismatchError,
	RestoreRefusedError,
	SetupClosedError,
} from "@webcraft/core";
import { DatabaseNotReadyError, MigrationError, ModuleMigrationError } from "@webcraft/db";

import type { CliIo } from "../io.ts";
import { backupCommand, checkUpdateCommand, migrateCommand, type RestoreOptions, restoreCommand } from "./backups.ts";
import { doctorCommand, healthCommand, mediaMoveCommand, setupCommand } from "./checks.ts";
import { createSuperadmin, parseCreateSuperadminOptions } from "./create-superadmin.ts";
import { resetTwoFactor } from "./reset-two-factor.ts";
import { parseRotateKeyOptions, rotateKey } from "./rotate-key.ts";

export const ADMIN_USAGE = `Usage: webcraft admin <command>

Server commands: run them on the server, with the Install's environment (the web image has webcraft).

  admin setup        Print a new one-time link to the setup wizard while the Install has no
                     Superadmin (the web process prints one in its log each time it starts).
  admin doctor [--json]
                     Check the environment, the database, the Master key, storage, mail, the worker,
                     Backups and the update check, each OK, Warning or Failing, saying what to do.
                     Exits 1 when anything is Failing.
  admin health [--worker]
                     For container health checks: whether the web process here answers /readyz
                     (PORT, on the admin host), or with --worker whether a worker checked in with the
                     database within the last 2 minutes. Exits 0 when healthy, 1 otherwise.
  admin media move --to s3|disk [--keep-source]
                     Move every stored Media file to the bucket or to local disk, checking each copy,
                     without changing any address. Switch Install settings › Storage there first, so
                     new files go there too. Stopped halfway, run it again: it goes on where it was.
                     The old copies are deleted unless --keep-source.
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
  admin reset-2fa <email>
                     Reset a person's two-factor authentication, such as a Superadmin who lost
                     theirs: their authenticator app, passkeys and backup codes are removed, they
                     are signed out everywhere and emailed, and they sign in with their password
                     and set it up again. Recorded in the Audit log as done by the command.

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

/** Runs `webcraft admin <command> …` and answers its exit code. */
export async function runAdmin(
	args: string[],
	io: CliIo,
	{ help, json }: { help: boolean; json: boolean },
): Promise<number> {
	try {
		return await dispatch(args, io, help, json);
	} catch (error) {
		const explained = EXPLAINED_ERRORS.some((kind) => error instanceof kind);
		const message =
			explained && error instanceof Error ? error.message : error instanceof Error ? error.stack : String(error);
		io.stderr(`webcraft: ${message}\n`);
		return 1;
	}
}

async function dispatch(args: string[], io: CliIo, help: boolean, json: boolean): Promise<number> {
	const [command, ...rest] = args;
	if (!command || command === "help" || help) {
		io.stdout(ADMIN_USAGE);
		return command || help ? 0 : 1;
	}
	if (command === "migrate" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--no-backup"))) {
		return migrateCommand(process.env, { backup: rest.length === 0 });
	}
	if (command === "backup") {
		const to = parseBackupOptions(rest);
		if (to !== null) return backupCommand(process.env, { to: to || undefined });
	}
	if (command === "restore") {
		const options = parseRestoreOptions(rest);
		if (options) return restoreCommand(process.env, options);
	}
	if (command === "check-update" && rest.length === 0) {
		return checkUpdateCommand(process.env);
	}
	if (command === "setup" && rest.length === 0) return setupCommand(io, process.env);
	if (command === "doctor" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))) {
		return doctorCommand(io, process.env, { json: rest[0] === "--json" || json });
	}
	if (command === "health" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--worker"))) {
		return healthCommand(io, process.env, { worker: rest[0] === "--worker" });
	}
	if (command === "media" && rest[0] === "move") {
		const options = parseMediaMoveOptions(rest.slice(1));
		if (options) return mediaMoveCommand(io, process.env, options);
	}
	if (command === "rotate-key") {
		const options = parseRotateKeyOptions(rest);
		if (options) return rotateKey(options);
	}
	if (command === "reset-2fa" && rest.length === 1 && !rest[0]?.startsWith("-")) {
		return resetTwoFactor(rest[0] ?? "");
	}
	if (command === "create-superadmin") {
		const options = parseCreateSuperadminOptions(rest);
		if (options) return createSuperadmin(options);
	}
	// Only the command is repeated: the rest could hold something secret typed in the wrong place.
	io.stderr(`Unknown command or options: webcraft admin ${command}\n\n${ADMIN_USAGE}`);
	return 1;
}

/** Reads `--to s3|disk [--keep-source]`; null for anything else. */
function parseMediaMoveOptions(args: string[]): { to: "s3" | "disk"; keepSource: boolean } | null {
	let to: "s3" | "disk" | undefined;
	let keepSource = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const value = arg === "--to" ? args[++index] : arg.startsWith("--to=") ? arg.slice(5) : undefined;
		if (value === "s3" || value === "disk") to = value;
		else if (arg === "--keep-source") keepSource = true;
		else return null;
	}
	return to ? { to, keepSource } : null;
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
