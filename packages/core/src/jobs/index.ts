import { consentRecordsPurge, consentRecordsPurgeSchedule } from "../consent/records.ts";
import {
	domainsCheck,
	domainsCheckAll,
	domainsCheckAllSchedule,
	domainsVerify,
	domainsVerifyDue,
	domainsVerifyDueSchedule,
} from "../domains/jobs.ts";
import { emailLogPurge, emailLogPurgeSchedule } from "../email/jobs.ts";
import { emailSend } from "../email/outbox.ts";
import { mediaProcess, mediaVariants } from "../media/jobs.ts";
import { mediaPurge, mediaPurgeSchedule } from "../media/trash.ts";
import {
	moduleDailyJobs,
	moduleDailyJobsSchedule,
	moduleEventJob,
	moduleHourlyJobs,
	moduleHourlyJobsSchedule,
	moduleJob,
	moduleMissesJob,
} from "../modules/jobs.ts";
import { moduleLogPurge, moduleLogPurgeSchedule } from "../modules/module-log.ts";
import { modulePartitionsJob, modulePartitionsSchedule } from "../modules/partitions.ts";
import { visitorSaltsPurge, visitorSaltsPurgeSchedule } from "../modules/visitors.ts";
import { rateLimitsPurge, rateLimitsPurgeSchedule } from "../rate-limits.ts";
import { searchRebuild, searchRebuildDue, searchRebuildDueSchedule } from "../search/jobs.ts";
import { siteFilesPurge, siteFilesPurgeSchedule } from "../site-scripts/retired.ts";
import { webhooksDeliver, webhooksPurgeLog, webhooksPurgeLogSchedule } from "../webhooks/jobs.ts";
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
	mediaPurge,
	moduleEventJob,
	moduleJob,
	moduleMissesJob,
	moduleHourlyJobs,
	moduleDailyJobs,
	moduleLogPurge,
	modulePartitionsJob,
	visitorSaltsPurge,
	siteFilesPurge,
	domainsVerifyDue,
	domainsVerify,
	domainsCheckAll,
	domainsCheck,
	searchRebuildDue,
	searchRebuild,
	consentRecordsPurge,
	webhooksDeliver,
	webhooksPurgeLog,
] as readonly JobDefinition<unknown>[];

/** Every job that runs on a schedule. The worker registers them; the test harness's drain runs them when due. */
export const coreSchedules = [
	emailLogPurgeSchedule,
	rateLimitsPurgeSchedule,
	moduleLogPurgeSchedule,
	moduleHourlyJobsSchedule,
	moduleDailyJobsSchedule,
	modulePartitionsSchedule,
	visitorSaltsPurgeSchedule,
	siteFilesPurgeSchedule,
	mediaPurgeSchedule,
	domainsVerifyDueSchedule,
	domainsCheckAllSchedule,
	searchRebuildDueSchedule,
	consentRecordsPurgeSchedule,
	webhooksPurgeLogSchedule,
] as readonly JobSchedule<unknown>[];

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
