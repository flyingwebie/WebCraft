import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

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

/** Deletes deliveries older than 30 days from every Webhook's delivery log. */
export const webhooksPurgeLog = defineJob({
	name: "webhooks.purge-log",
	payload: z.object({}),
	async run(_payload, { webhooks, log }) {
		const deleted = await webhooks.purgeLog();
		if (deleted > 0) log.info("Deleted old Webhook deliveries", { deliveries: deleted });
	},
});

/** The delivery log purge runs every day at 03:29 UTC. */
export const webhooksPurgeLogSchedule = defineSchedule({ job: webhooksPurgeLog, cron: "29 3 * * *", payload: {} });
