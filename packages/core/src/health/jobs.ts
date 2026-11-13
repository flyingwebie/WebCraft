import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

/** Works out Install health, stores it and sends the Health alerts that are due. */
export const healthCheck = defineJob({
	name: "health.check",
	payload: z.object({}),
	// A check that didn't run is replaced by the next one, a minute later.
	queue: { retryLimit: 0, expireInSeconds: 120 },
	async run(_payload, { health }) {
		await health.check("worker");
	},
});

/** Every minute, in the worker. */
export const healthCheckSchedule = defineSchedule({ job: healthCheck, cron: "* * * * *", payload: {} });
