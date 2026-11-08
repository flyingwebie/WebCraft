import type { JobDefinition } from "./define.ts";
import { samplePing } from "./sample-ping.ts";

/**
 * Every job the worker runs, and the test harness drains. A job that isn't listed here is never
 * worked, so add each new job to this list.
 */
export const coreJobs: readonly JobDefinition<unknown>[] = [samplePing];

export {
	createJobQueue,
	defineJob,
	ensureQueues,
	type JobContext,
	type JobDefinition,
	type JobQueue,
	runJob,
	workJobs,
} from "./define.ts";
export { samplePing } from "./sample-ping.ts";
