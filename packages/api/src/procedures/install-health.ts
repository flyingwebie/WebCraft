import { z } from "zod";

import { onInstall } from "../context.ts";
import { id } from "../inputs.ts";

/** Failed jobs of one queue to act on: those named, or all of them. */
const jobTarget = z.object({
	queue: z.string().trim().min(1).max(200),
	jobIds: z.union([z.literal("all"), z.array(id).min(1).max(500)]),
});

/**
 * Install health (spec story 14): every part of the Install, OK, Warning or Failing with a reason,
 * for the Superadmin only (`installHealth.manage`). Retrying and discarding failed jobs are recorded
 * in the Audit log.
 */
export const installHealth = {
	/**
	 * Every part as last worked out, or worked out now with `refresh` (the screen asks so when it
	 * opens, and for "Check now"): the worker's minute check keeps it, so pages never work it out.
	 */
	get: onInstall("installHealth.manage")
		.input(z.object({ refresh: z.boolean().default(false) }).default({ refresh: false }))
		.handler(async ({ context, input }) =>
			input.refresh ? context.services.health.check("screen") : context.services.health.read(),
		),

	/** Every queue with failed or stuck jobs, and its newest failed jobs (never their payloads). */
	queues: onInstall("installHealth.manage").handler(async ({ context }) => ({
		queues: await context.services.health.queues(20),
	})),

	/** Tries failed jobs again: some of a queue, or all of it. Recorded as `job.retry`. */
	retry: onInstall("installHealth.manage")
		.input(jobTarget)
		.handler(async ({ context, input }) => ({ retried: await context.services.health.retry(context.install, input) })),

	/** Deletes failed jobs for good: some of a queue, or all of it. Recorded as `job.discard`. */
	discard: onInstall("installHealth.manage")
		.input(jobTarget)
		.handler(async ({ context, input }) => ({
			discarded: await context.services.health.discard(context.install, input),
		})),
};
