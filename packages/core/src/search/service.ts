import type { Database } from "@webcraft/db";
import { sites } from "@webcraft/db/schema";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

import type { Clock } from "../clock.ts";

import type { Logger } from "../log.ts";
import type { DataLayer } from "../tenancy/data-layer.ts";
import { SEARCH_INDEX_VERSION } from "./index-version.ts";
import { rebuildSearchIndex } from "./indexing.ts";

/** Site search's background work: rebuilding indexes that are behind. */
export type SiteSearch = {
	/**
	 * For the worker: claims the Sites whose search index is behind (a change asked for a rebuild, or
	 * it was built for an older `SEARCH_INDEX_VERSION`) and that have no rebuild queued, at most
	 * `batch` of them, and answers each with its claim. A claim that hasn't ended in a rebuild after
	 * `REBUILD_CLAIM_LIFETIME_MS` (the job kept failing, or was never queued) lapses, and the Site is
	 * claimed again.
	 */
	claimStaleIndexes(batch?: number): Promise<{ siteId: string; claimedAt: string }[]>;
	/**
	 * For the worker: rebuilds one Site's search index from what is published now, then marks it
	 * current, unless the Site asked for another rebuild since `claimedAt` (the next sweep queues it).
	 */
	rebuild(siteId: string, claimedAt: string): Promise<void>;
};

/** How many Sites one `search.rebuild-due` run claims; the rest wait for the next minute. */
const CLAIM_BATCH = 100;

/** How long a queued rebuild has to finish before its Site is claimed again: past its job's retries. */
export const REBUILD_CLAIM_LIFETIME_MS = 60 * 60_000;

export function createSiteSearch(options: {
	database: Database;
	data: DataLayer;
	clock: Clock;
	log: Logger;
}): SiteSearch {
	const { database, data, clock, log } = options;
	return {
		async claimStaleIndexes(batch = CLAIM_BATCH) {
			const now = clock.now();
			const lapsed = new Date(now.getTime() - REBUILD_CLAIM_LIFETIME_MS);
			const behind = database.db
				.select({ id: sites.id })
				.from(sites)
				.where(
					and(
						lt(sites.searchIndexVersion, SEARCH_INDEX_VERSION),
						or(isNull(sites.searchRebuildClaimedAt), lt(sites.searchRebuildClaimedAt, lapsed)),
					),
				)
				.limit(batch)
				.for("update", { skipLocked: true });
			const claimed = await database.db
				.update(sites)
				.set({ searchRebuildClaimedAt: now })
				.where(inArray(sites.id, behind))
				.returning({ id: sites.id });
			return claimed.map((site) => ({ siteId: site.id, claimedAt: now.toISOString() }));
		},

		async rebuild(siteId, claimedAt) {
			const scope = await data.background(siteId);
			if (!scope) return;
			const { entries } = await rebuildSearchIndex(scope);
			// Current only while this rebuild's claim still holds: a change since then asked for another.
			const [current] = await database.db
				.update(sites)
				.set({ searchIndexVersion: SEARCH_INDEX_VERSION, searchRebuildClaimedAt: null })
				.where(and(eq(sites.id, siteId), eq(sites.searchRebuildClaimedAt, new Date(claimedAt))))
				.returning({ id: sites.id });
			log.info("Rebuilt a Site's search index", { siteId, entries, current: current !== undefined });
		},
	};
}
