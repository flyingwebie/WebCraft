import { sites } from "@webcraft/db/schema";
import { and, eq } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";

/**
 * Holds the Site's row until the transaction ends, so changes to its allowed hosts, outside scripts
 * and Libraries take turns: each counts what the Site has, against its limit, under the lock.
 */
export async function lockSite(scope: SiteScope): Promise<void> {
	await scope.db
		.select({ id: sites.id })
		.from(sites)
		.where(and(eq(sites.id, scope.site.id), eq(sites.workspaceId, scope.site.workspaceId)))
		.for("update");
}
