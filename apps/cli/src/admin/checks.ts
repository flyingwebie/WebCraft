import {
	ConfigError,
	createLogger,
	createWorkers,
	type Environment,
	FIRST_PARTY_MODULES,
	type InstallServices,
	type Logger,
	loadInstallConfig,
	loadMasterKey,
	MasterKeyMismatchError,
	MediaMoveRefusedError,
	moduleSchemas,
	moveMediaFiles,
	openInstallForCommand,
	systemClock,
	WEBCRAFT_VERSION,
	WORKER_FRESH_MS,
} from "@webcraft/core";
import { checkSchema, openDatabase } from "@webcraft/db";
import { createBunHttp } from "@webcraft/server/outgoing-http";

import type { CliIo } from "../io.ts";

/** Logs go to standard error as JSON lines, so the Install's log keeps a record of what the command did. */
function commandLog(io: CliIo): Logger {
	return createLogger({
		fields: { process: "cli" },
		write: (entry) => io.stderr(`${JSON.stringify(entry)}\n`),
	});
}

function ago(io: CliIo, then: Date): string {
	const seconds = Math.max(0, Math.round((io.now().getTime() - then.getTime()) / 1000));
	if (seconds < 120) return `${seconds} seconds ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 120) return `${minutes} minutes ago`;
	return `${Math.round(minutes / 60)} hours ago`;
}

/**
 * `webcraft admin setup`: a new one-time link to the setup wizard while the Install has no
 * Superadmin, for whoever can't find the token the web process printed in its log.
 */
export async function setupCommand(io: CliIo, env: Environment): Promise<number> {
	const services = await openInstallForCommand({ env, log: commandLog(io) });
	try {
		const stage = await services.setup.stage();
		if (stage === "done") {
			io.stdout("Setup is finished: this Install has its Superadmin and the setup wizard is closed.\n");
			return 0;
		}
		if (stage === "continue") {
			io.stdout(
				`The Superadmin exists. They finish setting up after signing in at ${new URL("/sign-in", services.config.adminOrigin)}\n`,
			);
			return 0;
		}
		const link = await services.setup.newSetupLink();
		if (!link) throw new ConfigError("A Superadmin was created meanwhile: setup needs no link any more.");
		io.stdout(
			"This Install has no Superadmin yet. Open the setup wizard to claim it (the link works once):\n" +
				`${link.setupUrl}\n` +
				`Setup token: ${link.token}\n` +
				"Or create the Superadmin from here: webcraft admin create-superadmin <email>\n",
		);
		return 0;
	} finally {
		await services.database.close();
	}
}

/**
 * `webcraft admin health [--worker]`, for container health checks: whether the web process in this
 * container answers `/readyz` (on `PORT`, asked on the admin host), or with `--worker` whether a
 * worker checked in with the database lately. Exits 0 when healthy, 1 otherwise.
 */
export async function healthCommand(io: CliIo, env: Environment, { worker }: { worker: boolean }): Promise<number> {
	if (worker) {
		const databaseUrl = env.DATABASE_URL?.trim();
		if (!databaseUrl)
			throw new ConfigError("DATABASE_URL is not set: health --worker reads the workers' check-ins there.");
		const database = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-cli" });
		try {
			const status = await createWorkers({ database, clock: systemClock }).status();
			if (status.working && status.latest) {
				io.stdout(
					`A worker is working the job queue: ${status.latest.hostname} checked in ${ago(io, status.latest.beatAt)} (WebCraft ${status.latest.version}).\n`,
				);
				return 0;
			}
			io.stdout(
				status.latest
					? `No worker has checked in for ${ago(io, status.latest.beatAt).replace(" ago", "")}: the last was ${status.latest.hostname}. Jobs (email, images, Backups) wait until one runs.\n`
					: "No worker has ever checked in: start the worker. Jobs (email, images, Backups) wait until one runs.\n",
			);
			return 1;
		} finally {
			await database.close();
		}
	}
	const port = env.PORT?.trim() || "3000";
	const adminHost = env.WEBCRAFT_ADMIN_HOST?.trim();
	if (!adminHost)
		throw new ConfigError("WEBCRAFT_ADMIN_HOST is not set: health asks the web process on the admin host.");
	try {
		const response = await io.fetch(
			new Request(`http://127.0.0.1:${port}/readyz`, {
				headers: { host: adminHost },
				signal: AbortSignal.timeout(4000),
			}),
		);
		if (response.status === 200) {
			io.stdout(`The web process on port ${port} is ready.\n`);
			return 0;
		}
		io.stdout(
			`The web process on port ${port} isn't ready (it answered ${response.status}): its database is unreachable or behind.\n`,
		);
		return 1;
	} catch {
		io.stdout(`No web process answers on port ${port}.\n`);
		return 1;
	}
}

type Check = { name: string; state: "ok" | "warning" | "failing"; detail: string };

/**
 * `webcraft admin doctor`: checks the Install's environment, database, Master key, storage, mail,
 * worker, Backups and the update check, each OK, Warning or Failing, and says what to do. Exits 1
 * when anything is Failing.
 */
export async function doctorCommand(io: CliIo, env: Environment, { json }: { json: boolean }): Promise<number> {
	const checks: Check[] = [];
	const add = (name: string, state: Check["state"], detail: string) => checks.push({ name, state, detail });
	const done = () => {
		if (json) io.stdout(`${JSON.stringify({ version: WEBCRAFT_VERSION, checks }, null, 2)}\n`);
		else {
			const marks = { ok: "✓", warning: "!", failing: "✗" };
			io.stdout(
				`${checks.map((check) => `${marks[check.state]} ${check.name}: ${check.detail}`).join("\n")}\n` +
					`${checks.some((check) => check.state === "failing") ? "Something is Failing: see above." : "Nothing is Failing."}\n`,
			);
		}
		return checks.some((check) => check.state === "failing") ? 1 : 0;
	};

	let databaseUrl: string;
	try {
		databaseUrl = loadInstallConfig(env).databaseUrl;
		loadMasterKey(env);
		add("Settings", "ok", `every setting web and worker need is there (WebCraft ${WEBCRAFT_VERSION}).`);
	} catch (error) {
		add("Settings", "failing", error instanceof Error ? error.message : String(error));
		return done();
	}

	const database = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-cli" });
	try {
		const schema = await checkSchema(database, { modules: moduleSchemas(FIRST_PARTY_MODULES) });
		if (schema.state === "unreachable") {
			add("Database", "failing", `it doesn't answer at DATABASE_URL (${schema.error.message}).`);
			return done();
		}
		if (schema.state === "behind") {
			add(
				"Database",
				"failing",
				`${schema.pendingMigrations.length} migration${schema.pendingMigrations.length === 1 ? " is" : "s are"} pending: run webcraft admin migrate.`,
			);
			return done();
		}
		if (schema.state === "job-queue-newer") {
			add(
				"Database",
				"failing",
				"the job queue's schema is newer than this version: restore the Backup taken before that update.",
			);
			return done();
		}
		add("Database", "ok", "it answers, and has every migration this version expects.");
	} finally {
		await database.close();
	}

	let services: InstallServices;
	try {
		services = await openInstallForCommand({ env, log: commandLog(io), http: createBunHttp() });
	} catch (error) {
		add(
			"Master key",
			"failing",
			error instanceof MasterKeyMismatchError
				? error.message
				: `the Install couldn't be opened: ${error instanceof Error ? error.message : String(error)}`,
		);
		return done();
	}
	try {
		const stored = await services.masterKey.status();
		add(
			"Master key",
			stored.stored ? "ok" : "warning",
			stored.stored
				? `WEBCRAFT_SECRET_KEY is the Install's (fingerprint ${services.masterKey.fingerprint}), and is stored outside the server.`
				: `WEBCRAFT_SECRET_KEY is the Install's (fingerprint ${services.masterKey.fingerprint}), but no Superadmin has confirmed it is stored outside the server. Without a copy, a lost server loses every secret.`,
		);

		try {
			const settings = await services.storage.settings();
			const storage = await services.storage.current();
			const key = `webcraft-check/doctor-${crypto.randomUUID()}`;
			const bytes = new TextEncoder().encode("webcraft doctor");
			await storage.put(key, bytes, "text/plain");
			const back = await storage.read(key);
			await storage.delete(key);
			if (!back || new TextDecoder().decode(back) !== "webcraft doctor")
				throw new Error("the file read back wasn't the one written");
			add(
				"Storage",
				"ok",
				settings.kind === "s3"
					? `new files go to the bucket ${settings.s3?.bucket ?? ""}: a check file was written, read back and removed.`
					: `new files go to ${settings.directory}: a check file was written, read back and removed.`,
			);
		} catch (error) {
			add("Storage", "failing", `files can't be stored: ${error instanceof Error ? error.message : String(error)}`);
		}

		const smtp = await services.email.installSmtp.health();
		if (smtp.state === "not-set") {
			add(
				"Mail",
				"warning",
				"no Install SMTP is set: System emails (invites, password resets, alerts) are only written to the log. Set it in Install settings › Email.",
			);
		} else if (smtp.state === "failing") {
			add(
				"Mail",
				"failing",
				`the Install SMTP failed ${smtp.failuresInARow} times in a row${smtp.lastResponse ? `: ${smtp.lastResponse}` : ""}.`,
			);
		} else add("Mail", "ok", "the Install SMTP sends.");

		const workers = await services.workers.status();
		if (workers.working && workers.latest) {
			add("Worker", "ok", `${workers.latest.hostname} checked in ${ago(io, workers.latest.beatAt)}.`);
		} else {
			add(
				"Worker",
				"failing",
				workers.latest
					? `no worker has checked in for more than ${WORKER_FRESH_MS / 60_000} minutes (the last was ${workers.latest.hostname}, ${ago(io, workers.latest.beatAt)}): start the worker.`
					: "no worker has ever checked in: start the worker. Jobs (email, images, Backups) wait until one runs.",
			);
		}

		const backups = await services.backups.status();
		if (backups.failing) {
			add("Backups", "failing", `the last Backup failed${backups.last?.problem ? `: ${backups.last.problem}` : ""}.`);
		} else if (!backups.lastDone) {
			add(
				"Backups",
				"warning",
				"no Backup has been taken yet: the worker takes one every night (or run webcraft admin backup).",
			);
		} else add("Backups", "ok", `the last one was taken ${ago(io, new Date(backups.lastDone.startedAt))}.`);

		const update = await services.updates.latest();
		if (!update.enabled) add("Updates", "ok", "the update check is off (WEBCRAFT_UPDATE_FEED=off).");
		else if (update.updateAvailable && update.latest) {
			add("Updates", "warning", `WebCraft ${update.latest.version} is available; this is ${update.running}.`);
		} else add("Updates", "ok", `this is WebCraft ${update.running}${update.latest ? ", the newest release" : ""}.`);
	} finally {
		await services.database.close();
	}
	return done();
}

/** `webcraft admin media move --to s3|disk [--keep-source]`. */
export async function mediaMoveCommand(
	io: CliIo,
	env: Environment,
	{ to, keepSource }: { to: "s3" | "disk"; keepSource: boolean },
): Promise<number> {
	const log = commandLog(io);
	const services = await openInstallForCommand({ env, log, http: createBunHttp() });
	try {
		let told = 0;
		const report = await moveMediaFiles(
			{ database: services.database, storage: services.storage, log },
			{
				to,
				keepSource,
				onProgress: ({ moved, total }) => {
					if (moved - told >= 25 || moved === total) {
						told = moved;
						io.stdout(`Moved ${moved} of ${total} files…\n`);
					}
				},
			},
		);
		const where = to === "s3" ? "the bucket" : "local disk";
		io.stdout(
			report.moved === 0 && report.missing.length === 0
				? `Every Media file is already in ${where}: nothing to move.\n`
				: `Moved ${report.moved} file${report.moved === 1 ? "" : "s"} (${size(report.bytes)}) to ${where}${keepSource ? ", keeping the copies they came from" : ""}. Their addresses are the same.\n`,
		);
		if (report.missing.length > 0) {
			io.stdout(
				`${report.missing.length} file${report.missing.length === 1 ? " was" : "s were"} in neither storage, so their items stay as they were:\n${report.missing.map((key) => `  ${key}`).join("\n")}\n`,
			);
			return 1;
		}
		return 0;
	} catch (error) {
		if (error instanceof MediaMoveRefusedError) throw new ConfigError(error.message);
		throw error;
	} finally {
		await services.database.close();
	}
}

function size(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
