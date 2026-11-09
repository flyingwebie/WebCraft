import { assertSchemaCurrent, createBoss, type Database, type JobQueueOptions, openDatabase } from "@webcraft/db";
import type { ModuleDefinition } from "@webcraft/module-sdk";
import type { PgBoss } from "pg-boss";

import { createHttpAiProviders } from "./ai/http-providers.ts";
import { systemClock } from "./clock.ts";
import { type Environment, type InstallConfig, loadInstallConfig } from "./config.ts";
import { countriesFromFile, unknownCountries } from "./countries.ts";
import { createInstallServices } from "./create-services.ts";
import { systemDns } from "./dns.ts";
import { createSmtpMailer } from "./email/smtp-mailer.ts";
import { createGuardedFetch } from "./guarded-fetch.ts";
import type { OutgoingHttp } from "./http.ts";
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
	/**
	 * Outgoing HTTP on the process's runtime (ADR 0006), connecting each call the guarded fetcher
	 * checked to the address it checked: the worker hands in `createNodeHttp()`, the web process its
	 * Bun one.
	 */
	http: OutgoingHttp;
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
		{
			...realPorts(config, database, log, options.http),
			jobs: createJobQueue(boss),
			images: options.images ?? imagesOnlyInWorker,
		},
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
export async function openInstallForCommand(options: {
	env: Environment;
	log: Logger;
	/** Outgoing HTTP for commands that make a call the guarded fetcher checks (`check-update`). */
	http?: OutgoingHttp;
}): Promise<InstallServices> {
	const { env, log } = options;
	const config = loadInstallConfig(env);
	const masterKey = loadMasterKey(env);
	const database = openDatabase(config.databaseUrl, { maxConnections: 2, applicationName: "webcraft-cli" });
	try {
		await assertSchemaCurrent(database, { modules: moduleSchemas(FIRST_PARTY_MODULES) });
		return await createInstallServices(
			{
				// Most server commands make no call the guarded fetcher checks.
				...realPorts(config, database, log, options.http ?? unpinnedHttp),
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

/**
 * Opens an Install's services for a server command that sends jobs, such as a System email (the
 * worker sends it), with the same checks as `openInstallForCommand`. The job queue only sends, as
 * the web process's does. Call `close` when done.
 */
export async function openInstallForCommandSendingJobs(options: {
	env: Environment;
	log: Logger;
}): Promise<{ services: InstallServices; close(): Promise<void> }> {
	const { env, log } = options;
	const config = loadInstallConfig(env);
	const masterKey = loadMasterKey(env);
	const database = openDatabase(config.databaseUrl, { maxConnections: 2, applicationName: "webcraft-cli" });
	let boss: PgBoss | undefined;
	try {
		await assertSchemaCurrent(database, { modules: moduleSchemas(FIRST_PARTY_MODULES) });
		boss = createBoss(config.databaseUrl, {
			...JOB_QUEUE_OPTIONS.web,
			application_name: "webcraft-cli",
			instanceName: "cli",
		});
		boss.on("error", (error) => log.error("The job queue reported an error", { error }));
		const services = await createInstallServices(
			{
				...realPorts(config, database, log, unpinnedHttp),
				jobs: createJobQueue(boss),
				images: imagesOnlyInWorker,
			},
			masterKey,
		);
		await boss.start();
		const started = boss;
		return {
			services,
			async close() {
				await started.stop({ graceful: true });
				await database.close();
			},
		};
	} catch (error) {
		await boss?.stop({ graceful: false }).catch(() => {});
		await database.close();
		throw error;
	}
}

/** Outgoing HTTP that can't pin a call to an address, for processes that never make such a call. */
const unpinnedHttp: OutgoingHttp = (request, call) => {
	if (call?.connectTo !== undefined) throw new Error("This process can't connect a call to a checked address.");
	return fetch(request);
};

/** The real adapters every process uses; only outgoing HTTP and the job queue differ between them. */
function realPorts(
	config: InstallConfig,
	database: Database,
	log: Logger,
	http: OutgoingHttp,
): Omit<InstallPorts, "jobs" | "images"> {
	return {
		config,
		database,
		mailer: createSmtpMailer(),
		http,
		dns: systemDns,
		tls: systemTls,
		countries: config.countryFile ? countriesFromFile(config.countryFile, log) : unknownCountries,
		// AI providers are called directly, through the guarded fetcher on this process's outgoing HTTP.
		ai: createHttpAiProviders({ fetch: createGuardedFetch({ http, dns: systemDns }) }),
		clock: systemClock,
		log,
	};
}
