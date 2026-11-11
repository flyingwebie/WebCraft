/**
 * Picks up again the Import work whose worker stopped for good (killed, out of memory, a job that was
 * never sent): Import runs (`recoverRuns`), which would otherwise keep their Import from running again,
 * and the surveys of source files (`recoverSurveys`).
 */
import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import { recoverRuns } from "./runs.ts";
import { recoverSurveys } from "./survey.ts";

export const importsRecover = defineJob({
	name: "imports.recover",
	payload: z.object({}),
	queue: { retryLimit: 0 },
	async run(_payload, context) {
		await recoverRuns(context);
		await recoverSurveys(context);
	},
});

/** Every ten minutes. */
export const importsRecoverSchedule = defineSchedule({ job: importsRecover, cron: "*/10 * * * *", payload: {} });
