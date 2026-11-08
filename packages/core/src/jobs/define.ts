import type { PgBoss, Queue, SendOptions } from "pg-boss";
import type { z } from "zod";

import type { InstallServices } from "../services.ts";

/** What a job can use while it runs: the same services the web process has. */
export type JobContext = InstallServices;

/**
 * One kind of background job. The worker runs it; any process can enqueue it through the
 * `JobQueue`. Payloads are checked with `payload` when they are sent and again when they run.
 */
export type JobDefinition<Payload> = {
	/** The queue name, `area.action`, such as `email.send`. Never rename one that shipped. */
	name: string;
	payload: z.ZodType<Payload>;
	/** Retry, expiry and retention settings for this job's queue. */
	queue?: Omit<Queue, "name">;
	run(payload: Payload, context: JobContext): Promise<void>;
};

/** Declares a job. The worker only runs jobs that are in its job list (see `jobs/index.ts`). */
export function defineJob<Payload>(definition: JobDefinition<Payload>): JobDefinition<Payload> {
	return definition;
}

/** Enqueues jobs. The web process and jobs themselves use it; the worker runs what it holds. */
export type JobQueue = {
	send<Payload>(job: JobDefinition<Payload>, payload: Payload, options?: SendOptions): Promise<string>;
};

/** A JobQueue on top of a started pg-boss instance. */
export function createJobQueue(boss: PgBoss): JobQueue {
	const created = new Map<string, Promise<void>>();
	return {
		async send(job, payload, options = {}) {
			const data = job.payload.parse(payload);
			let ready = created.get(job.name);
			if (!ready) {
				ready = ensureQueue(boss, job);
				created.set(job.name, ready);
			}
			await ready;
			const id = await boss.send(job.name, data as object, options);
			if (!id) {
				throw new Error(`The job queue did not accept a "${job.name}" job.`);
			}
			return id;
		},
	};
}

/** Creates each job's queue if it doesn't exist yet. */
export async function ensureQueues(boss: PgBoss, jobs: readonly JobDefinition<unknown>[]): Promise<void> {
	for (const job of jobs) {
		await ensureQueue(boss, job);
	}
}

async function ensureQueue(boss: PgBoss, job: JobDefinition<unknown>): Promise<void> {
	if (!(await boss.getQueue(job.name))) {
		await boss.createQueue(job.name, job.queue);
	}
}

/** Runs one job: checks its payload, then calls the job with a logger that names it. */
export async function runJob<Payload>(job: JobDefinition<Payload>, data: unknown, context: JobContext): Promise<void> {
	const payload = job.payload.parse(data);
	await job.run(payload, { ...context, log: context.log.child({ job: job.name }) });
}

/** Starts working every job in `jobs`: the worker process's main loop. */
export async function workJobs(
	boss: PgBoss,
	jobs: readonly JobDefinition<unknown>[],
	context: JobContext,
): Promise<void> {
	await ensureQueues(boss, jobs);
	for (const job of jobs) {
		await boss.work(job.name, async (batch) => {
			for (const item of batch) {
				await runJob(job, item.data, context);
			}
		});
	}
}
