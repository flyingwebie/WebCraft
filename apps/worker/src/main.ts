// The worker process (Node LTS, ADR 0006): works the job queue until it is told to stop.
// Node runs this TypeScript directly, so every relative import names its `.ts` file.
import {
	coreJobs,
	coreSchedules,
	createLogger,
	type OpenedParts,
	openInstall,
	scheduleJobs,
	workJobs,
} from "@webcraft/core";

/** How long a stopping worker waits for running jobs to finish. */
const STOP_TIMEOUT_MS = 30_000;

const log = createLogger({ fields: { process: "worker" } });

/** What has been opened so far, so a stop signal at any moment closes exactly that. */
const running: OpenedParts = {};

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

	const { services, boss } = await openInstall({ env: process.env, processName: "worker", log, opened: running });
	// Schedules first: a stop signal that comes once jobs run then never lands in the middle of them.
	await scheduleJobs(boss, coreSchedules);
	await workJobs(boss, coreJobs, services);
	log.info("The worker is working the job queue", {
		jobs: coreJobs.map((job) => job.name),
		schedules: coreSchedules.map((schedule) => `${schedule.job.name} (${schedule.cron})`),
	});
}

main().catch((error: unknown) => {
	log.error("The worker could not start", { error });
	process.exit(1);
});
