import { z } from "zod";

import { defineJob } from "../jobs/define.ts";

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
