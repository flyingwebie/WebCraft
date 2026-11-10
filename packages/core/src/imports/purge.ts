import { importFiles, importRuns, imports, secrets } from "@webcraft/db/schema";
import { and, eq, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import { connectionOf } from "./connection.ts";
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
		// Scoped purge of live logins, even when the Module is switched off.
		const connected = await database.db
			.select({ siteId: imports.siteId })
			.from(imports)
			.where(isNotNull(imports.connection));
		for (const siteId of new Set(connected.map((row) => row.siteId))) {
			const scope = await data.background(siteId);
			if (!scope) continue;
			for (const row of await scope.select(imports, isNotNull(imports.connection))) {
				await scope.transaction(async (tx) => {
					const [current] = await tx.db
						.select()
						.from(imports)
						.where(tx.where(imports, eq(imports.id, row.id)))
						.for("update");
					const connection = connectionOf(current?.connection);
					if (current && (!connection || new Date(connection.expiresAt).getTime() <= now.getTime()))
						await tx.secrets.remove(`import:${row.id}:credentials`);
				});
			}
		}
		// A process killed during Test connection can leave its temporary encrypted candidate.
		const candidateCutoff = new Date(now.getTime() - 86400_000);
		const abandoned = and(
			sql`${secrets.name} ~ '^import:[a-f0-9-]+:credentials:test$'`,
			lt(secrets.updatedAt, candidateCutoff),
		);
		const candidates = await database.db
			.select({ siteId: secrets.siteId, name: secrets.name })
			.from(secrets)
			.where(abandoned);
		for (const { siteId, name } of candidates) {
			const scope = siteId ? await data.background(siteId) : null;
			if (scope) await scope.secrets.remove(name, candidateCutoff);
		}

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
