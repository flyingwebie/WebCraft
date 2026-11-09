import { assertSchemaCurrent, createBoss, type Database, type JobQueueOptions, openDatabase } from "@webcraft/db";
import type { ModuleDefinition } from "@webcraft/module-sdk";
import type { PgBoss } from "pg-boss";

import { systemClock } from "./clock.ts";
import { type Environment, type InstallConfig, loadInstallConfig } from "./config.ts";
import { createInstallServices } from "./create-services.ts";
import { systemDns } from "./dns.ts";
import { createSmtpMailer } from "./email/smtp-mailer.ts";
import { fetchHttp } from "./http.ts";
import { createJobQueue } from "./jobs/define.ts";
import type { Logger } from "./log.ts";
import { type ImageProcessor, imagesOnlyInWorker } from "./media/images.ts";
import { FIRST_PARTY_MODULES } from "./modules/first-party.ts";
import { moduleSchemas } from "./modules/schemas.ts";
import { loadMasterKey } from "./secrets/master-key.ts";
import type { InstallPorts, InstallServices } from "./services.ts";
import { systemTls } from "./tls.ts";

/** The two long-running processes of an Install (ADR 0006). */
export type InstallProcess = "web" | "worker";

const JOB_QUEUE_OPTIONS: Record<InstallProcess, JobQueueOptions> = {
	// The web process only sends jobs; the worker works them and does the queue's upkeep.
	web: { supervise: false, schedule: false },
	worker: {},
};

/** What has been opened so far, so a process told to stop part-way closes exactly that. */
export type OpenedParts = { database?: Database; boss?: PgBoss };

export type OpenInstallOptions = {
	env: Environment;
	processName: InstallProcess;
	log: Logger;
	/** Filled in as each part opens. */
	opened?: OpenedParts;
	/** Image processing: the worker hands in the real one; the web process never processes images. */
	images?: ImageProcessor;
	/** The Modules to load: the first-party Modules of this build unless given. */
	modules?: readonly ModuleDefinition[];
};

/**
 * Opens a running Install's services from the environment, refusing to start when a setting is
 * missing (including a Master key under 32 characters) or the database is behind (ADR 0031).
 */
export async function openInstall(options: OpenInstallOptions): Promise<{ services: InstallServices; boss: PgBoss }> {
	const { env, processName, log } = options;
	const opened = options.opened ?? {};
	const config = loadInstallConfig(env);
	const masterKey = loadMasterKey(env);
	const applicationName = `webcraft-${processName}`;

	const database = openDatabase(config.databaseUrl, { applicationName });
	opened.database = database;
	const modules = options.modules ?? FIRST_PARTY_MODULES;
	await assertSchemaCurrent(database, { modules: moduleSchemas(modules) });

	const boss = createBoss(config.databaseUrl, {
		...JOB_QUEUE_OPTIONS[processName],
		application_name: applicationName,
		instanceName: processName,
	});
	boss.on("error", (error) => log.error("The job queue reported an error", { error }));

	// Built before the job queue starts, so a wrong Master key is refused first.
	const services = await createInstallServices(
		{ ...realPorts(config, database, log), jobs: createJobQueue(boss), images: options.images ?? imagesOnlyInWorker },
		masterKey,
		{ modules },
	);
	opened.boss = boss;
	await boss.start();
	return { services, boss };
}

/**
 * Opens an Install's services for a server command (`webcraft admin …`), with the same settings and
 * start-up checks as web and worker (a missing setting, a database that is behind, a Master key that
 * isn't the Install's), but without the job queue. Close `services.database` when done.
 */
export async function openInstallForCommand(options: { env: Environment; log: Logger }): Promise<InstallServices> {
	const { env, log } = options;
	const config = loadInstallConfig(env);
	const masterKey = loadMasterKey(env);
	const database = openDatabase(config.databaseUrl, { maxConnections: 2, applicationName: "webcraft-cli" });
	try {
		await assertSchemaCurrent(database, { modules: moduleSchemas(FIRST_PARTY_MODULES) });
		return await createInstallServices(
			{
				...realPorts(config, database, log),
				jobs: { send: () => Promise.reject(new Error("Server commands don't send jobs.")) },
				images: imagesOnlyInWorker,
			},
			masterKey,
		);
	} catch (error) {
		await database.close();
		throw error;
	}
}

/** The real adapters every process uses; only the job queue differs between them. */
function realPorts(config: InstallConfig, database: Database, log: Logger): Omit<InstallPorts, "jobs" | "images"> {
	return {
		config,
		database,
		mailer: createSmtpMailer(),
		http: fetchHttp,
		dns: systemDns,
		tls: systemTls,
		clock: systemClock,
		log,
	};
}
