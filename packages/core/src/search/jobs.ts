import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

/**
 * Rebuilds one Site's search index from what is published now (ADR 0021): after its Searched fields,
 * their weights or its languages changed, or for a new version of the index. Retried with backoff;
 * every run rebuilds the whole index, so a retry finishes the job.
 */
export const searchRebuild = defineJob({
	name: "search.rebuild",
	payload: z.object({ siteId: z.uuid(), claimedAt: z.iso.datetime() }),
	queue: { retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 3600 },
	run: ({ siteId, claimedAt }, context) => context.search.rebuild(siteId, claimedAt),
});

/** Every minute: a `search.rebuild` job for each Site whose search index is behind. */
export const searchRebuildDue = defineJob({
	name: "search.rebuild-due",
	payload: z.object({}),
	queue: { retryLimit: 0 },
	run: async (_payload, context) => {
		for (const claim of await context.search.claimStaleIndexes()) await context.jobs.send(searchRebuild, claim);
	},
});

export const searchRebuildDueSchedule = defineSchedule({ job: searchRebuildDue, cron: "* * * * *", payload: {} });
