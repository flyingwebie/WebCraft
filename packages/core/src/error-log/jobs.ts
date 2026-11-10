import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import { ERROR_LOG_DAYS } from "./service.ts";

/** Deletes the Error log's causes not seen for 30 days. */
export const errorLogPrune = defineJob({
	name: "error-log.prune",
	payload: z.object({}),
	async run(_payload, { errorLog, log }) {
		const removed = await errorLog.prune();
		if (removed > 0) log.info("Deleted Error log causes not seen for 30 days", { removed, keptDays: ERROR_LOG_DAYS });
	},
});

/** The prune runs every day at 03:57 UTC. */
export const errorLogPruneSchedule = defineSchedule({ job: errorLogPrune, cron: "57 3 * * *", payload: {} });
