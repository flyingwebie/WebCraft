#!/usr/bin/env bun
// The `webcraft` command line. For now it has the server commands `admin migrate` and
// `admin rotate-key`; the generated remote commands, `login` and the other server commands arrive
// with the CLI ticket.
import { readFile } from "node:fs/promises";
import {
	ConfigError,
	KeyRotationError,
	loadDatabaseUrl,
	loadMasterKey,
	MASTER_KEY_MIN_LENGTH,
	type MasterKey,
	OLD_MASTER_KEY_VARIABLE,
	parseMasterKey,
	rotateMasterKey,
	systemClock,
} from "@webcraft/core";
import { assertSchemaCurrent, DatabaseNotReadyError, openDatabase, runMigrations } from "@webcraft/db";

const USAGE = `Usage: webcraft <command>

Server commands (run on the server, with the Install's environment):
  admin migrate      Apply pending database migrations and install or upgrade the job queue schema.
                     Run it before starting a new version of web and worker.
  admin rotate-key [--old-key-file <path>]
                     Re-encrypt every secret under a new Master key. Stop web and worker first.
                     WEBCRAFT_SECRET_KEY holds the new key; the key being replaced comes from
                     WEBCRAFT_OLD_SECRET_KEY, or from the file given with --old-key-file.

Options:
  -h, --help         Show this help.
`;

/** Errors whose message says everything: shown without a stack trace. */
const EXPLAINED_ERRORS = [ConfigError, DatabaseNotReadyError, KeyRotationError];

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
	process.stderr.write(`Unknown command: webcraft ${args.join(" ")}\n\n${USAGE}`);
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

type RotateKeyOptions = { oldKeyFile?: string };

function parseRotateKeyOptions(args: string[]): RotateKeyOptions | null {
	if (args.length === 0) return {};
	const [flag, path, ...rest] = args;
	if (rest.length === 0 && path && flag === "--old-key-file") return { oldKeyFile: path };
	if (rest.length === 0 && !path && flag?.startsWith("--old-key-file=")) {
		return { oldKeyFile: flag.slice("--old-key-file=".length) };
	}
	return null;
}

async function rotateKey(options: RotateKeyOptions): Promise<number> {
	const databaseUrl = loadDatabaseUrl(process.env);
	const newKey = loadMasterKey(process.env);
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
		const secrets = `${report.reencrypted} secret${report.reencrypted === 1 ? "" : "s"}`;
		process.stdout.write(
			`Re-encrypted ${secrets} under Master key version ${report.version}.\n` +
				`Fingerprint of the new Master key: ${report.fingerprint}\n` +
				"Start web and worker with the new key in WEBCRAFT_SECRET_KEY, and keep a copy of it outside the server. The old key no longer opens anything.\n",
		);
		return 0;
	} finally {
		await database.close();
	}
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
