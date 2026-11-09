/**
 * The Trash of a Site's Media library. Deleting a file puts it there for 30 days: it is no longer
 * served, shown on pages or chosen for Fields, and it can be restored as it was. After 30 days (or
 * once someone deletes it for good, or empties the Trash) it is deleted with its stored files,
 * except bytes another item still shares. Files that Replace file put aside go the same way.
 */
import { media, mediaFiles } from "@webcraft/db/schema";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import type { BackgroundScope, SiteScope } from "../tenancy/data-layer.ts";
import type { InstallStorage } from "./install-storage.ts";
import { noticeQuotaUse } from "./quota.ts";
import type { StorageKind } from "./storage.ts";

/** How long a file stays in the Trash, and a replaced file is still served. */
export const TRASH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

type Scope = Pick<SiteScope, "select" | "delete"> | BackgroundScope;

/** A stored file, by the storage holding it and its key there. */
export type StoredFile = { storage: string; key: string };

/**
 * Removes stored files no row of the Site names any more, once the change that let them go is
 * saved. Identical bytes uploaded twice share one stored file, so it goes with the last item holding it.
 */
export async function removeUnusedFiles(
	scope: Pick<SiteScope, "count">,
	storage: InstallStorage,
	files: readonly StoredFile[],
): Promise<void> {
	const seen = new Set<string>();
	for (const file of files) {
		const id = `${file.storage}\u0000${file.key}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const named = await scope.count(
			mediaFiles,
			and(eq(mediaFiles.storage, file.storage), eq(mediaFiles.key, file.key)),
		);
		if (named === 0) await (await storage.holding(file.storage as StorageKind)).delete(file.key);
	}
}

/**
 * Deletes Media items for good: their rows (their files' rows go with them). Answers the stored
 * files to hand to `removeUnusedFiles` once the change is saved.
 */
export async function deleteForGood(scope: Scope, mediaIds: readonly string[]): Promise<StoredFile[]> {
	if (mediaIds.length === 0) return [];
	const files = await scope.select(mediaFiles, inArray(mediaFiles.mediaId, [...mediaIds]));
	await scope.delete(media, inArray(media.id, [...mediaIds]));
	return files;
}

/**
 * One Site's items in the Trash and replaced files older than `before`, deleted. Answers how many
 * went and the stored files to remove once the change is saved.
 */
async function purgeSite(
	scope: BackgroundScope,
	before: Date,
): Promise<{ items: number; replaced: number; files: StoredFile[] }> {
	const expired = await scope.select(media, and(isNotNull(media.trashedAt), lt(media.trashedAt, before)));
	const files = await deleteForGood(
		scope,
		expired.map((row) => row.id),
	);
	const retired = await scope.select(
		mediaFiles,
		and(isNotNull(mediaFiles.retiredAt), lt(mediaFiles.retiredAt, before)),
	);
	if (retired.length > 0) {
		await scope.delete(
			mediaFiles,
			inArray(
				mediaFiles.id,
				retired.map((file) => file.id),
			),
		);
	}
	return { items: expired.length, replaced: retired.length, files: [...files, ...retired] };
}

/**
 * Every day, deletes for good the Media items in the Trash for more than 30 days and the files
 * Replace file put aside more than 30 days ago, on every Site. A Workspace that frees space below
 * 80% of its quota is warned again next time it passes it.
 */
export const mediaPurge = defineJob({
	name: "media.purge",
	payload: z.object({}),
	async run(_payload, { database, data, storage, clock, log, email }) {
		const before = new Date(clock.now().getTime() - TRASH_LIFETIME_MS);
		const sites = new Set<string>();
		for (const row of await database.db
			.selectDistinct({ siteId: media.siteId })
			.from(media)
			.where(and(isNotNull(media.trashedAt), lt(media.trashedAt, before)))) {
			sites.add(row.siteId);
		}
		for (const row of await database.db
			.selectDistinct({ siteId: mediaFiles.siteId })
			.from(mediaFiles)
			.where(and(isNotNull(mediaFiles.retiredAt), lt(mediaFiles.retiredAt, before)))) {
			sites.add(row.siteId);
		}
		for (const siteId of sites) {
			const scope = await data.background(siteId);
			if (!scope) continue;
			const { files, ...purged } = await scope.transaction((tx) => purgeSite(tx, before));
			await removeUnusedFiles(scope, storage, files);
			await noticeQuotaUse(scope.db, { email, log, clock }, scope.workspace);
			log.info("Deleted Media from the Trash and replaced files for good", { siteId, ...purged });
		}
	},
});

/** The purge runs every day at 03:47 UTC. */
export const mediaPurgeSchedule = defineSchedule({ job: mediaPurge, cron: "47 3 * * *", payload: {} });
