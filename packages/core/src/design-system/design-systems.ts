/**
 * Where each Site's Design system is kept: one `design_systems` row holding the Draft and the
 * published version as documents (`@webcraft/renderer` › `DesignSystem`), made the first time the
 * Site changes its Design system. Until then the Draft is the default one, and until its first
 * publish visitors see the default one.
 */
import { designSystems } from "@webcraft/db/schema";
import { type DesignSystem, defaultDesignSystem, readDesignSystem } from "@webcraft/renderer";
import { eq } from "drizzle-orm";

import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";

export type DesignSystemRow = typeof designSystems.$inferSelect;

/** A Design system row, read and held until its transaction ends, with both versions read. */
export type LockedDesignSystem = { row: DesignSystemRow; draft: DesignSystem; published: DesignSystem | null };

/** The Draft of the Site's Design system: the default one until the Site changes it. */
export async function draftDesignSystem(scope: Pick<SiteScope | VisitorScope, "first">): Promise<DesignSystem> {
	const row = await scope.first(designSystems);
	return row ? readDesignSystem(row.draft) : defaultDesignSystem();
}

/**
 * Reads the Site's Design system for a change, holding it until the transaction ends so changes
 * never overwrite each other; made with the default Draft the first time.
 */
export async function lockDesignSystem(scope: SiteScope): Promise<LockedDesignSystem> {
	const now = scope.now();
	await scope.db
		.insert(designSystems)
		.values({
			workspaceId: scope.site.workspaceId,
			siteId: scope.site.id,
			draft: defaultDesignSystem(),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
	const [row] = await scope.db.select().from(designSystems).where(scope.where(designSystems)).for("update");
	if (!row) throw new Error("The Design system row is missing.");
	return {
		row,
		draft: readDesignSystem(row.draft),
		published: row.published === null ? null : readDesignSystem(row.published),
	};
}

/** Saves a new Draft over a locked Design system. */
export async function writeDraft(scope: SiteScope, locked: LockedDesignSystem, draft: DesignSystem): Promise<void> {
	await scope.update(designSystems, { draft, updatedAt: scope.now() }, eq(designSystems.id, locked.row.id));
}
