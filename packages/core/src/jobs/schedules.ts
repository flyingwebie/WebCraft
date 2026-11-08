import type { PgBoss } from "pg-boss";

import type { JobDefinition } from "./define.ts";

/**
 * A job that runs on a schedule, such as the daily Email log purge. The worker registers every
 * schedule in `coreSchedules` with the job queue, which sends the job each time `cron` comes due.
 */
export type JobSchedule<Payload> = {
	job: JobDefinition<Payload>;
	/** A cron expression, read in UTC, such as `17 3 * * *` (every day at 03:17). */
	cron: string;
	payload: Payload;
};

export function defineSchedule<Payload>(schedule: JobSchedule<Payload>): JobSchedule<Payload> {
	return schedule;
}

/**
 * Registers every schedule with the job queue (the worker does this when it starts) and removes the
 * ones no longer listed. When the worker was down at a due time, the job runs once when it is back.
 */
export async function scheduleJobs(boss: PgBoss, schedules: readonly JobSchedule<unknown>[]): Promise<void> {
	for (const schedule of schedules) {
		await boss.schedule(schedule.job.name, schedule.cron, schedule.payload as object, { tz: "UTC", missed: "once" });
	}
	const listed = new Set(schedules.map((schedule) => schedule.job.name));
	for (const existing of await boss.getSchedules()) {
		if (!listed.has(existing.name)) await boss.unschedule(existing.name, existing.key);
	}
}
