import type { PgBoss, Queue, SendOptions } from "pg-boss";
import type { z } from "zod";

import { currentLogContext, withLogContext } from "../log.ts";
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
	/**
	 * Tries failed jobs of a queue again (Install health's Retry): answers how many went back in the
	 * queue. Only a process with a job queue has it (not server commands).
	 */
	retry?(queue: string, jobIds: readonly string[]): Promise<number>;
	/** Deletes failed jobs of a queue for good (Install health's Discard): answers how many. */
	discard?(queue: string, jobIds: readonly string[]): Promise<number>;
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
			const id = await boss.send(job.name, carryingRequestId(data), options);
			if (!id) {
				throw new Error(`The job queue did not accept a "${job.name}" job.`);
			}
			return id;
		},
		async retry(queue, jobIds) {
			if (jobIds.length === 0) return 0;
			return affected(await boss.retry(queue, [...jobIds]));
		},
		async discard(queue, jobIds) {
			if (jobIds.length === 0) return 0;
			return affected(await boss.deleteJob(queue, [...jobIds]));
		},
	};
}

/** How many jobs a job queue command changed: its answer says, though its type doesn't. */
function affected(answer: object): number {
	const count = (answer as { affected?: unknown }).affected;
	return typeof count === "number" ? count : 0;
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

/**
 * Where a job's data carries the id of the request that queued it (or of the job that queued it,
 * which had it from its own), so the job's log lines carry it too. Never part of the payload.
 */
const REQUEST_ID_FIELD = "_requestId";

/** A payload as the queue keeps it: with the current request id, when there is one. */
function carryingRequestId(data: unknown): object {
	const { requestId } = currentLogContext();
	if (!requestId || data === null || typeof data !== "object" || Array.isArray(data)) return data as object;
	return { ...data, [REQUEST_ID_FIELD]: requestId };
}

/** What the queue holds for one job besides its payload, for its log lines. */
export type JobRunInfo = { id?: string };

/**
 * Runs one job: checks its payload, then calls the job. Every log line it writes meanwhile names the
 * job (and its id) and carries the request id it was queued with; a job that fails is logged as an
 * error (an unexpected failure: a job handles the failures it expects itself) and thrown on, for the
 * queue to retry.
 */
export async function runJob<Payload>(
	job: JobDefinition<Payload>,
	data: unknown,
	context: JobContext,
	info: JobRunInfo = {},
): Promise<void> {
	const { [REQUEST_ID_FIELD]: requestId, ...rest } =
		data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const fields = {
		job: job.name,
		...(info.id ? { jobId: info.id } : {}),
		...(typeof requestId === "string" ? { requestId } : {}),
	};
	await withLogContext(fields, async () => {
		try {
			const payload = job.payload.parse(requestId === undefined ? data : rest);
			await job.run(payload, { ...context, log: context.log.child({ job: job.name }) });
		} catch (error) {
			context.log.error("A job failed", { error });
			throw error;
		}
	});
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
				await runJob(job, item.data, context, { id: item.id });
			}
		});
	}
}
