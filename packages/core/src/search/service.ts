import type { Database } from "@webcraft/db";
import { sites } from "@webcraft/db/schema";
import { inArray, lt } from "drizzle-orm";

import type { Logger } from "../log.ts";
import type { DataLayer } from "../tenancy/data-layer.ts";
import { SEARCH_INDEX_VERSION } from "./index-version.ts";
import { rebuildSearchIndex } from "./indexing.ts";

/** Site search's background work: rebuilding indexes that are behind. */
export type SiteSearch = {
	/**
	 * For the worker: claims the Sites whose search index is behind (a change asked for a rebuild, or
	 * it was built for an older `SEARCH_INDEX_VERSION`), at most `batch` of them, marking them current
	 * first so no rebuild is queued twice, and answers their ids.
	 */
	claimStaleIndexes(batch?: number): Promise<string[]>;
	/** For the worker: rebuilds one Site's search index from what is published now. */
	rebuild(siteId: string): Promise<void>;
};

/** How many Sites one `search.rebuild-due` run claims; the rest wait for the next minute. */
const CLAIM_BATCH = 100;

export function createSiteSearch(options: { database: Database; data: DataLayer; log: Logger }): SiteSearch {
	const { database, data, log } = options;
	return {
		async claimStaleIndexes(batch = CLAIM_BATCH) {
			const behind = database.db
				.select({ id: sites.id })
				.from(sites)
				.where(lt(sites.searchIndexVersion, SEARCH_INDEX_VERSION))
				.limit(batch)
				.for("update", { skipLocked: true });
			const claimed = await database.db
				.update(sites)
				.set({ searchIndexVersion: SEARCH_INDEX_VERSION })
				.where(inArray(sites.id, behind))
				.returning({ id: sites.id });
			return claimed.map((site) => site.id);
		},

		async rebuild(siteId) {
			const scope = await data.background(siteId);
			if (!scope) return;
			const { entries } = await rebuildSearchIndex(scope);
			log.info("Rebuilt a Site's search index", { siteId, entries });
		},
	};
}
