// The worker process (Node LTS, ADR 0006): works the job queue until it is told to stop.
// Node runs this TypeScript directly, so every relative import names its `.ts` file.
import { hostname } from "node:os";
import {
	coreJobs,
	coreSchedules,
	createLogger,
	createNodeHttp,
	ensureQueues,
	logSettings,
	type OpenedParts,
	openInstall,
	scheduleJobs,
	startWorkerHeartbeat,
	workJobs,
} from "@webcraft/core";

import { createImageProcessor } from "./images.ts";
import { createChromiumPdf } from "./pdf.ts";

/** How long a stopping worker waits for running jobs to finish. */
const STOP_TIMEOUT_MS = 30_000;

const log = createLogger({ fields: { process: "worker" }, ...logSettings(process.env) });

/** What has been opened so far, so a stop signal at any moment closes exactly that. */
const running: OpenedParts = {};
/** This worker's check-ins, once it works the job queue. */
let heartbeat: { stop(): Promise<void> } | undefined;

async function stop(signal: NodeJS.Signals): Promise<void> {
	log.info("The worker is stopping", { signal });
	try {
		await heartbeat?.stop();
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

	const { services, boss } = await openInstall({
		env: process.env,
		processName: "worker",
		log,
		opened: running,
		// Only the worker processes images (ADR 0027).
		images: createImageProcessor(),
		// Only the worker renders Reports' PDFs, with the headless Chromium its image carries.
		pdf: createChromiumPdf(),
		http: createNodeHttp(),
	});
	// Every job's queue first: a schedule names its queue, which a new Install doesn't have yet.
	await ensureQueues(boss, coreJobs);
	// Schedules before work: a stop signal that comes once jobs run then never lands in the middle of them.
	await scheduleJobs(boss, coreSchedules);
	await workJobs(boss, coreJobs, services);
	// It checks in every 30 seconds while it runs: `webcraft admin health --worker` reads that.
	heartbeat = await startWorkerHeartbeat(services.workers, { hostname: hostname(), log });
	log.info("The worker is working the job queue", {
		jobs: coreJobs.map((job) => job.name),
		schedules: coreSchedules.map((schedule) => `${schedule.job.name} (${schedule.cron})`),
	});
}

main().catch((error: unknown) => {
	log.error("The worker could not start", { error });
	process.exit(1);
});
