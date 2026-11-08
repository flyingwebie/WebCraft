import { emailLogPurge, emailLogPurgeSchedule } from "../email/jobs.ts";
import { emailSend } from "../email/outbox.ts";
import { mediaProcess, mediaVariants } from "../media/jobs.ts";
import { rateLimitsPurge, rateLimitsPurgeSchedule } from "../rate-limits.ts";
import type { JobDefinition } from "./define.ts";
import { samplePing } from "./sample-ping.ts";
import type { JobSchedule } from "./schedules.ts";

/**
 * Every job the worker runs, and the test harness drains. A job that isn't listed here is never
 * worked, so add each new job to this list.
 */
export const coreJobs = [
	samplePing,
	emailSend,
	emailLogPurge,
	rateLimitsPurge,
	mediaProcess,
	mediaVariants,
] as readonly JobDefinition<unknown>[];

/** Every job that runs on a schedule. The worker registers them; the test harness's drain runs them when due. */
export const coreSchedules = [emailLogPurgeSchedule, rateLimitsPurgeSchedule] as readonly JobSchedule<unknown>[];

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
export { defineSchedule, type JobSchedule, scheduleJobs } from "./schedules.ts";
