import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import { EMAIL_LOG_RETENTION_DAYS } from "./email-log.ts";

/** Deletes Email log lines older than 90 days. */
export const emailLogPurge = defineJob({
	name: "email.purge-log",
	payload: z.object({}),
	async run(_payload, { email, log }) {
		const deleted = await email.emailLog.purge();
		log.info("Deleted old Email log lines", { deleted, keptDays: EMAIL_LOG_RETENTION_DAYS });
	},
});

/** The Email log purge runs every day at 03:17 UTC. */
export const emailLogPurgeSchedule = defineSchedule({ job: emailLogPurge, cron: "17 3 * * *", payload: {} });
