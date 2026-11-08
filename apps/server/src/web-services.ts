import {
	createJobQueue,
	createLogger,
	createLogMailer,
	fetchHttp,
	type InstallServices,
	loadInstallConfig,
	systemClock,
} from "@webcraft/core";
import { assertSchemaCurrent, createBoss, openDatabase } from "@webcraft/db";

type Cache = { webcraftWebServices?: Promise<InstallServices> };

/**
 * Builds the web process's services from the environment, refusing to start when a setting is
 * missing or the database is behind (ADR 0031). `vite dev` re-runs the server entry after every
 * change, so the services are kept on `globalThis` and opened only once per process.
 */
export function startWebServices(env: Record<string, string | undefined> = process.env): Promise<InstallServices> {
	const cache = globalThis as Cache;
	cache.webcraftWebServices ??= openWebServices(env).catch((error: unknown) => {
		cache.webcraftWebServices = undefined;
		throw error;
	});
	return cache.webcraftWebServices;
}

async function openWebServices(env: Record<string, string | undefined>): Promise<InstallServices> {
	const config = loadInstallConfig(env);
	const log = createLogger({ fields: { process: "web" } });
	const database = openDatabase(config.databaseUrl, { applicationName: "webcraft-web" });
	await assertSchemaCurrent(database);

	// The web process only sends jobs; the worker works them and does the queue's upkeep.
	const boss = createBoss(config.databaseUrl, {
		supervise: false,
		schedule: false,
		application_name: "webcraft-web",
		instanceName: "web",
	});
	boss.on("error", (error) => log.error("The job queue reported an error", { error }));
	await boss.start();

	return {
		config,
		database,
		jobs: createJobQueue(boss),
		// Until Install SMTP exists, emails are written to the log with a warning.
		mailer: createLogMailer(log),
		http: fetchHttp,
		clock: systemClock,
		log,
	};
}
