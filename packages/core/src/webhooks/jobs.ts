import { z } from "zod";

import { defineJob } from "../jobs/define.ts";

/**
 * One attempt of a Webhook delivery. What the receiver did is recorded in the delivery log and the
 * next attempt queued with its wait, so the job itself completes; the queue retries it only when
 * something unexpected breaks (the database).
 */
export const webhooksDeliver = defineJob({
	name: "webhooks.deliver",
	payload: z.object({
		siteId: z.uuid(),
		deliveryId: z.uuid(),
		attempt: z.number().int().min(1),
		round: z.number().int().min(1),
	}),
	queue: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 120 },
	run: (payload, context) => context.webhooks.runAttempt(payload),
});
