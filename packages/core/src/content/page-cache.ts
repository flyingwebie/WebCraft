import { sites } from "@webcraft/db/schema";
import { and, eq, sql } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";

/**
 * Clears the Site's whole page cache, inside the scope's transaction when it has one, so the pages
 * change together with what was published. The web process keeps each rendered page under the Site's
 * page cache generation; raising it here retires every page it holds for the Site. It works the
 * same from the web process and the worker, and from any number of web processes.
 */
export async function clearPageCache(scope: SiteScope): Promise<void> {
	await scope.db
		.update(sites)
		.set({ pageCacheGeneration: sql`${sites.pageCacheGeneration} + 1` })
		.where(and(eq(sites.id, scope.site.id), eq(sites.workspaceId, scope.workspace.id)));
}
