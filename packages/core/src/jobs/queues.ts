import type { JobQueueDefinition } from "@webcraft/db";

import type { JobDefinition } from "./define.ts";

/** The job queues of these jobs, with their retry and expiry settings, as the migrate step makes them. */
export function jobQueues(jobs: readonly JobDefinition<unknown>[]): JobQueueDefinition[] {
	return jobs.map((job) => ({ name: job.name, ...(job.queue ? { options: job.queue } : {}) }));
}
