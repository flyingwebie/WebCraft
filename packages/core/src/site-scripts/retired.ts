/**
 * Script files a change stopped using (ADR 0023). Every script a page loads is a file named by its
 * hash, kept by browsers for a year; a page loaded just before a publish, an update of a Library or a
 * change to an outside script still asks for the old file. So each replaced file is still served for
 * 30 days, like replaced stylesheets, then forgotten by `site-files.purge`.
 */
import type { Database } from "@webcraft/db";
import { libraries, retiredLibraryFiles, retiredScriptFiles } from "@webcraft/db/schema";
import { and, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import type { StorageKind } from "../media/storage.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";

/** How long a replaced script or Library file is still served. */
export const RETIRED_FILE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Keeps script files a change replaced (`hash`, `code`); one kept again is kept longer. */
export async function retireScriptFiles(
	scope: SiteScope,
	files: readonly { hash: string; code: string }[],
): Promise<void> {
	const now = scope.now();
	for (const file of files) {
		await scope.db
			.insert(retiredScriptFiles)
			.values({ workspaceId: scope.site.workspaceId, siteId: scope.site.id, ...file, retiredAt: now })
			.onConflictDoUpdate({ target: [retiredScriptFiles.siteId, retiredScriptFiles.hash], set: { retiredAt: now } });
	}
}

/** A replaced script file by its hash, while it is still served; null otherwise. */
export async function retiredScript(scope: Pick<VisitorScope, "first" | "now">, hash: string): Promise<string | null> {
	const row = await scope.first(retiredScriptFiles, eq(retiredScriptFiles.hash, hash));
	if (!row || row.retiredAt.getTime() <= scope.now().getTime() - RETIRED_FILE_LIFETIME_MS) return null;
	return row.code;
}

/** A Library file a change replaced, as stored. */
export type RetiredLibraryFile = { name: string; storage: StorageKind; storageKey: string };

/** Keeps a Library file an update or a removal replaced. */
export async function retireLibraryFile(scope: SiteScope, file: RetiredLibraryFile): Promise<void> {
	const now = scope.now();
	await scope.db
		.insert(retiredLibraryFiles)
		.values({ workspaceId: scope.site.workspaceId, siteId: scope.site.id, ...file, retiredAt: now })
		.onConflictDoUpdate({ target: [retiredLibraryFiles.siteId, retiredLibraryFiles.name], set: { retiredAt: now } });
}

/** A file that is a Library's again is no longer a replaced one (so the purge never removes it). */
export async function unretireLibraryFile(scope: SiteScope, name: string): Promise<void> {
	await scope.delete(retiredLibraryFiles, eq(retiredLibraryFiles.name, name));
}

/** A replaced Library file by its name, while it is still served; null otherwise. */
export async function retiredLibrary(
	scope: Pick<VisitorScope, "first" | "now">,
	name: string,
): Promise<RetiredLibraryFile | null> {
	const row = await scope.first(retiredLibraryFiles, eq(retiredLibraryFiles.name, name));
	if (!row || row.retiredAt.getTime() <= scope.now().getTime() - RETIRED_FILE_LIFETIME_MS) return null;
	return { name: row.name, storage: row.storage as StorageKind, storageKey: row.storageKey };
}

/**
 * Forgets replaced script and Library files older than 30 days, on every Site, removing the Library
 * files from storage (unless a Library holds the same file again). Answers how many went.
 */
export async function purgeRetiredFiles(
	{ database, storage }: { database: Database; storage: InstallStorage },
	now: Date,
): Promise<{ scripts: number; libraries: number }> {
	const { db } = database;
	const before = new Date(now.getTime() - RETIRED_FILE_LIFETIME_MS);
	const scripts = await db.delete(retiredScriptFiles).where(lt(retiredScriptFiles.retiredAt, before)).returning();
	const old = await db.select().from(retiredLibraryFiles).where(lt(retiredLibraryFiles.retiredAt, before));
	for (const file of old) {
		const [inUse] = await db
			.select({ id: libraries.id })
			.from(libraries)
			.where(and(eq(libraries.siteId, file.siteId), eq(libraries.storageKey, file.storageKey)));
		if (!inUse) await (await storage.holding(file.storage as StorageKind)).delete(file.storageKey);
	}
	if (old.length > 0) {
		await db.delete(retiredLibraryFiles).where(
			inArray(
				retiredLibraryFiles.id,
				old.map((file) => file.id),
			),
		);
	}
	return { scripts: scripts.length, libraries: old.length };
}

/** Forgets script and Library files replaced more than 30 days ago, on every Site. */
export const siteFilesPurge = defineJob({
	name: "site-files.purge",
	payload: z.object({}),
	async run(_payload, { database, storage, clock, log }) {
		const purged = await purgeRetiredFiles({ database, storage }, clock.now());
		log.info("Forgot replaced script and Library files", purged);
	},
});

/** The purge runs every day at 03:37 UTC. */
export const siteFilesPurgeSchedule = defineSchedule({ job: siteFilesPurge, cron: "37 3 * * *", payload: {} });
