import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import { BackupBusyError, BackupFailedError } from "./take.ts";

/**
 * The scheduled Backup: every day, while Install settings › Backups has it on, the worker takes a
 * Backup and then removes the scheduled ones the keep rules no longer keep. A Backup that fails is
 * in the Backup log with why, and the Superadmin sees a notice until one succeeds; it isn't retried
 * before the next day.
 */
export const backupsScheduled = defineJob({
	name: "backups.scheduled",
	payload: z.object({}),
	queue: { retryLimit: 0, expireInSeconds: 6 * 60 * 60 },
	async run(_payload, { backups, log }) {
		if (!(await backups.settings()).scheduled) return;
		try {
			await backups.take({ reason: "scheduled" });
		} catch (error) {
			if (error instanceof BackupBusyError) {
				log.warn("The scheduled Backup was skipped: another Backup was being taken", { error });
				return;
			}
			// The Backup log and the log say why; the next day's Backup tries again.
			if (error instanceof BackupFailedError) return;
			throw error;
		}
		await backups.prune();
	},
});

/** Every day at 01:11 UTC. */
export const backupsScheduledSchedule = defineSchedule({ job: backupsScheduled, cron: "11 1 * * *", payload: {} });
