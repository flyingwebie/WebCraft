import type { Database, Transaction } from "@webcraft/db";
import { moduleLog } from "@webcraft/db/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

type Executor = Database["db"] | Transaction;

export type ModuleLogLevel = "info" | "warn" | "error";

/** One line of the Module log. */
export type ModuleLogLine = {
	id: string;
	at: Date;
	level: ModuleLogLevel;
	message: string;
	workspaceId: string | null;
	siteId: string | null;
	details: Record<string, unknown>;
};

export type NewModuleLogLine = Omit<ModuleLogLine, "id" | "at"> & { moduleId: string };

/** How long Module log lines are kept. */
export const MODULE_LOG_DAYS = 90;

/** Writes one line of the Module log. Never put a secret's value in it. */
export async function writeModuleLog(executor: Executor, at: Date, line: NewModuleLogLine): Promise<void> {
	await executor.insert(moduleLog).values({ occurredAt: at, ...line, details: line.details ?? {} });
}

/** A Module's newest log lines, newest first. */
export async function listModuleLog(
	executor: Executor,
	moduleId: string,
	options: { limit: number },
): Promise<ModuleLogLine[]> {
	const rows = await executor
		.select()
		.from(moduleLog)
		.where(eq(moduleLog.moduleId, moduleId))
		.orderBy(desc(moduleLog.id))
		.limit(options.limit);
	return rows.map((row) => ({
		id: String(row.id),
		at: row.occurredAt,
		level: row.level as ModuleLogLevel,
		message: row.message,
		workspaceId: row.workspaceId,
		siteId: row.siteId,
		details: (row.details ?? {}) as Record<string, unknown>,
	}));
}

/** Deletes Module log lines older than 90 days, every day. */
export const moduleLogPurge = defineJob({
	name: "modules.purge-log",
	payload: z.object({}),
	async run(_payload, { database, clock, log }) {
		const before = new Date(clock.now().getTime() - MODULE_LOG_DAYS * 24 * 60 * 60 * 1000);
		const deleted = await database.db
			.delete(moduleLog)
			.where(and(lt(moduleLog.occurredAt, before)))
			.returning({ id: moduleLog.id });
		if (deleted.length > 0) log.info("Deleted old Module log lines", { lines: deleted.length });
	},
});

export const moduleLogPurgeSchedule = defineSchedule({ job: moduleLogPurge, cron: "37 3 * * *", payload: {} });
