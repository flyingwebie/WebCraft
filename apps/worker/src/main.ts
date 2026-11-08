// The worker process (Node LTS, ADR 0006): works the job queue until it is told to stop.
// Node runs this TypeScript directly, so every relative import names its `.ts` file.
import {
	coreJobs,
	createJobQueue,
	createLogger,
	createLogMailer,
	fetchHttp,
	type InstallServices,
	loadInstallConfig,
	systemClock,
	workJobs,
} from "@webcraft/core";
import { assertSchemaCurrent, createBoss, type Database, openDatabase } from "@webcraft/db";

/** How long a stopping worker waits for running jobs to finish. */
const STOP_TIMEOUT_MS = 30_000;

const log = createLogger({ fields: { process: "worker" } });

/** What has been opened so far, so a stop signal at any moment closes exactly that. */
const running: { boss?: ReturnType<typeof createBoss>; database?: Database } = {};

async function stop(signal: NodeJS.Signals): Promise<void> {
	log.info("The worker is stopping", { signal });
	try {
		await running.boss?.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
		await running.database?.close();
		process.exit(0);
	} catch (error) {
		log.error("The worker did not stop cleanly", { error });
		process.exit(1);
	}
}

async function main(): Promise<void> {
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);

	const config = loadInstallConfig(process.env);
	running.database = openDatabase(config.databaseUrl, { applicationName: "webcraft-worker" });
	await assertSchemaCurrent(running.database);

	const boss = createBoss(config.databaseUrl, { application_name: "webcraft-worker", instanceName: "worker" });
	boss.on("error", (error) => log.error("The job queue reported an error", { error }));
	running.boss = boss;
	await boss.start();

	const services: InstallServices = {
		config,
		database: running.database,
		jobs: createJobQueue(boss),
		// Until Install SMTP exists, emails are written to the log with a warning.
		mailer: createLogMailer(log),
		http: fetchHttp,
		clock: systemClock,
		log,
	};
	await workJobs(boss, coreJobs, services);
	log.info("The worker is working the job queue", { jobs: coreJobs.map((job) => job.name) });
}

main().catch((error: unknown) => {
	log.error("The worker could not start", { error });
	process.exit(1);
});
