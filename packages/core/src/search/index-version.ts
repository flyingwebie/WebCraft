import { sites } from "@webcraft/db/schema";
import { and, eq } from "drizzle-orm";

import type { Executor, Site } from "../tenancy/data-layer.ts";

/**
 * The version of WebCraft's search index. A Site whose index was built for an older one (or for none,
 * 0) is rebuilt by the `search.rebuild-due` job: raise it when what documents hold changes (the text a
 * Field type gives, a language's text search configuration), and every Site's index is rebuilt.
 */
export const SEARCH_INDEX_VERSION = 1;

/**
 * Asks for the Site's search index to be rebuilt, inside the scope's transaction: what its documents
 * are built from changed (Searched fields or their weights, the Site's languages, its Default
 * language), or a publish couldn't index an Entry. The `search.rebuild-due` job rebuilds it within a
 * minute; until then the index answers as it was.
 */
export async function markSearchIndexStale(scope: { db: Executor; site: Site }): Promise<void> {
	await scope.db
		.update(sites)
		// A rebuild already queued may have read what changed before it changed: it won't mark the
		// index current (its claim is gone), and the next sweep queues another.
		.set({ searchIndexVersion: 0, searchRebuildClaimedAt: null })
		.where(and(eq(sites.id, scope.site.id), eq(sites.workspaceId, scope.site.workspaceId)));
}
