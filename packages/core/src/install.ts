import { assertSchemaCurrent, createBoss, type Database, type JobQueueOptions, openDatabase } from "@webcraft/db";
import type { PgBoss } from "pg-boss";

import { systemClock } from "./clock.ts";
import { type Environment, loadInstallConfig } from "./config.ts";
import { createInstallServices } from "./create-services.ts";
import { fetchHttp } from "./http.ts";
import { createJobQueue } from "./jobs/define.ts";
import type { Logger } from "./log.ts";
import { createLogMailer } from "./mailer.ts";
import { loadMasterKey } from "./secrets/master-key.ts";
import type { InstallServices } from "./services.ts";

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
	await assertSchemaCurrent(database);

	const boss = createBoss(config.databaseUrl, {
		...JOB_QUEUE_OPTIONS[processName],
		application_name: applicationName,
		instanceName: processName,
	});
	boss.on("error", (error) => log.error("The job queue reported an error", { error }));

	// Built before the job queue starts, so a wrong Master key is refused first.
	const services = await createInstallServices(
		{
			config,
			database,
			jobs: createJobQueue(boss),
			// Until Install SMTP exists, emails are written to the log with a warning.
			mailer: createLogMailer(log),
			http: fetchHttp,
			clock: systemClock,
			log,
		},
		masterKey,
	);
	opened.boss = boss;
	await boss.start();
	return { services, boss };
}
