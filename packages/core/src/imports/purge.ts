import { importFiles, importRuns } from "@webcraft/db/schema";
import { and, isNotNull, lt, notInArray } from "drizzle-orm";
import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import { deleteFile } from "./files.ts";

/**
 * Every day, purges the Import reports whose run ended more than 90 days ago (the run, its changes
 * and its problems; the Import and the Source ids of what it brought in stay), and deletes the files
 * uploaded for Imports that no run took within a day, on every Site.
 */
export const importsPurge = defineJob({
	name: "imports.purge",
	payload: z.object({}),
	async run(_payload, { database, data, storage, clock, log }) {
		const now = clock.now();
		const expiredRuns = await database.db
			.selectDistinct({ siteId: importRuns.siteId })
			.from(importRuns)
			.where(and(isNotNull(importRuns.expiresAt), lt(importRuns.expiresAt, now)));
		for (const { siteId } of expiredRuns) {
			const scope = await data.background(siteId);
			if (!scope) continue;
			const reports = await scope.delete(importRuns, lt(importRuns.expiresAt, now));
			log.info("Purged Import reports kept 90 days", { siteId, reports });
		}
		// A file a run took is the run's to delete when it ends.
		const taken = database.db.select({ id: importRuns.fileId }).from(importRuns).where(isNotNull(importRuns.fileId));
		const unused = await database.db
			.select()
			.from(importFiles)
			.where(and(lt(importFiles.expiresAt, now), notInArray(importFiles.id, taken)));
		for (const file of unused) {
			const scope = await data.background(file.siteId);
			if (!scope) continue;
			await deleteFile(scope, storage, file);
		}
		if (unused.length > 0) log.info("Deleted files uploaded for Imports that no run took", { files: unused.length });
	},
});

/** The purge runs every day at 04:23 UTC. */
export const importsPurgeSchedule = defineSchedule({ job: importsPurge, cron: "23 4 * * *", payload: {} });
