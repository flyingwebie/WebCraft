import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

/**
 * Every minute: runs each Scheduled publish whose time came (`runDueScheduledPublishes`), so one runs
 * within a minute of its time. When the worker was down at a due time, the job runs once when it is
 * back and runs every Scheduled publish missed meanwhile, each saying in the Audit log how late it
 * was. Not retried: the next minute's look is the next try.
 */
export const scheduledPublishesDue = defineJob({
	name: "publishing.scheduled-due",
	payload: z.object({}),
	queue: { retryLimit: 0, expireInSeconds: 600 },
	run: async (_payload, context) => {
		await context.publishing.runDue();
	},
});

export const scheduledPublishesDueSchedule = defineSchedule({
	job: scheduledPublishesDue,
	cron: "* * * * *",
	payload: {},
});
