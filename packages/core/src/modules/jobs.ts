import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

/** Where a Module's queued work runs: a Site, or a Workspace for Workspace-level Modules. */
const place = z.union([
	z.object({ level: z.literal("site"), workspaceId: z.uuid(), siteId: z.uuid() }),
	z.object({ level: z.literal("workspace"), workspaceId: z.uuid() }),
]);

export type QueuedPlace = z.infer<typeof place>;

/** A failure is tried twice more, a minute and then a few minutes later; each failure goes to the Module log. */
const RETRIES = { retryLimit: 2, retryDelay: 60, retryBackoff: true } as const;

/**
 * One event for one Module (ADR 0024: Modules react afterwards, as background jobs). It runs only
 * if the Module still runs where the event happened when the job runs.
 */
const queuedEvent = z.object({
	moduleId: z.string().max(64),
	event: z.string().max(64),
	workspaceId: z.uuid(),
	siteId: z.uuid(),
	occurredAt: z.iso.datetime(),
	data: z.record(z.string(), z.unknown()),
});

export type QueuedEvent = z.infer<typeof queuedEvent>;

export const moduleEventJob = defineJob<QueuedEvent>({
	name: "modules.event",
	payload: queuedEvent,
	queue: RETRIES,
	run: (payload, services): Promise<void> => services.modules.runEvent(payload),
});

const queuedJob = z.object({ moduleId: z.string().max(64), job: z.string().max(64), place, payload: z.unknown() });

export type QueuedJob = z.infer<typeof queuedJob>;

/** One of a Module's own jobs, queued with `context.jobs.send`. Its payload is JSON. */
export const moduleJob = defineJob<QueuedJob>({
	name: "modules.job",
	payload: queuedJob,
	queue: RETRIES,
	run: (payload, services): Promise<void> => services.modules.runJob(payload),
});

/**
 * Modules' scheduled jobs (`schedules` in a definition): every hour and every day, each Module job
 * scheduled that often is queued once in every place where its Module runs.
 */
export const moduleHourlyJobs = defineJob({
	name: "modules.hourly",
	payload: z.object({}),
	run: (_payload, services): Promise<void> => services.modules.runSchedules("hour"),
});

export const moduleDailyJobs = defineJob({
	name: "modules.daily",
	payload: z.object({}),
	run: (_payload, services): Promise<void> => services.modules.runSchedules("day"),
});

/** Modules' hourly jobs are queued at seven minutes past every hour, UTC. */
export const moduleHourlyJobsSchedule = defineSchedule({ job: moduleHourlyJobs, cron: "7 * * * *", payload: {} });

/** Modules' daily jobs are queued every day at 03:47 UTC. */
export const moduleDailyJobsSchedule = defineSchedule({ job: moduleDailyJobs, cron: "47 3 * * *", payload: {} });

/** One Site's misses for the 404 log, gathered by a web process (SDK 1.4): see `ModuleHost.noteMiss`. */
const queuedMisses = z.object({
	moduleId: z.string().max(64),
	workspaceId: z.uuid(),
	siteId: z.uuid(),
	misses: z
		.array(
			z.object({
				path: z.string().max(2000),
				language: z.string().max(64),
				referrerHost: z.string().max(253).nullable(),
				hits: z.number().int().min(1),
				firstAt: z.iso.datetime(),
				lastAt: z.iso.datetime(),
			}),
		)
		.max(1000),
});

export type QueuedMisses = z.infer<typeof queuedMisses>;

/** Hands a batch of a Site's misses to the Module keeping the 404 log, where it still runs. */
export const moduleMissesJob = defineJob<QueuedMisses>({
	name: "modules.notFound",
	payload: queuedMisses,
	queue: RETRIES,
	run: (payload, services): Promise<void> => services.modules.runMisses(payload),
});
