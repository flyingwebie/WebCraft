import { accessibilityStatements, components, entries, templates } from "@webcraft/db/schema";
import type { ElementTree, TreeNode } from "@webcraft/renderer";
import { childListsOf } from "@webcraft/renderer";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { type ComponentVersion, storedComponentVersion } from "./component-versions.ts";
import type { ComponentUse } from "./errors.ts";
import { linksIn } from "./field-values.ts";
import { sameJson } from "./json.ts";
import { layoutLinks } from "./page-layouts.ts";
import { getPostType } from "./post-types.ts";
import { saveMigratedVersions } from "./prop-migrations.ts";
import { saveLinks } from "./relationships.ts";
import { storedVersion } from "./values.ts";

/**
 * Removing a Component's Placements, for deleting a Component that is placed (the building area's
 * Components place: SPEC 10, "Deleting it removes every instance"). A Placement is only the
 * Component's id and its own Prop values, so with the Component gone it would show nothing: removing
 * them leaves every tree as it would render, and nothing pointing at a Component that isn't there.
 *
 * What can go: the Placements in every Template's and Component's Draft and published tree (at any
 * depth, inside elements, Loops and Conditions) and in every Page's layout, Draft and published. What
 * can't: a Popup shows the Component itself, and the accessibility statement's footer link is that
 * Component; those uses keep refusing the delete (`componentBlockers`).
 */

/** The uses of a Component that removing Placements can't take away: Popups showing it, the accessibility statement. */
export async function componentBlockers(
	scope: SiteScope,
	componentId: string,
	usedIn: readonly ComponentUse[],
): Promise<ComponentUse[]> {
	const statement = await scope.first(accessibilityStatements);
	const statementPage = statement?.componentId === componentId ? statement.pageId : null;
	return usedIn.filter((use) => use.kind === "popup" || (use.kind === "entry" && use.id === statementPage));
}

/** A copy of `tree` without the Placements of `componentId`, at any depth; null when it places none. */
function withoutPlacements(tree: ElementTree, componentId: string): ElementTree | null {
	const copy = structuredClone(tree);
	let removed = false;
	const visit = (nodes: TreeNode[]) => {
		for (let at = nodes.length - 1; at >= 0; at--) {
			const node = nodes[at] as TreeNode;
			if (node.type === "component" && node.component === componentId) {
				nodes.splice(at, 1);
				removed = true;
				continue;
			}
			// The child lists are the node's own arrays, so taking from them changes the copy.
			for (const children of childListsOf(node)) visit(children as TreeNode[]);
		}
	};
	visit(copy.nodes as TreeNode[]);
	return removed ? copy : null;
}

/**
 * Removes every Placement of `componentId` from the Site's Templates, Components and Page layouts,
 * Draft and published, inside the caller's transaction (which holds the Site's Component lock). Each
 * Draft changed is noted as a change of its own item (a Checkpoint, as any save), and a Page's links
 * follow its layout. The caller clears the page cache: published trees change.
 */
export async function removeComponentPlacements(scope: SiteScope, componentId: string): Promise<void> {
	for (const [table, kind] of [
		[templates, "template"],
		[components, "component"],
	] as const) {
		const rows = await scope.db.select().from(table).where(scope.where(table)).orderBy(table.id).for("update");
		for (const row of rows) {
			if (kind === "component" && row.id === componentId) continue;
			const change: { draft?: unknown; published?: unknown } = {};
			for (const which of ["draft", "published"] as const) {
				const stored = row[which];
				if (stored === null) continue;
				if (kind === "template") {
					const tree = withoutPlacements(stored as ElementTree, componentId);
					if (tree) change[which] = tree;
				} else {
					const version: ComponentVersion = storedComponentVersion(stored);
					const tree = withoutPlacements(version.tree, componentId);
					if (tree) change[which] = { ...(stored as object), tree };
				}
			}
			if (Object.keys(change).length) await saveMigratedVersions(scope, table, kind, row, change);
		}
	}
	const rows = await scope.db.select().from(entries).where(scope.where(entries)).orderBy(entries.id).for("update");
	for (const row of rows) {
		const change: { draft?: unknown; published?: unknown } = {};
		for (const which of ["draft", "published"] as const) {
			if (!row[which]) continue;
			const version = structuredClone(storedVersion(row[which]));
			if (!version.layout) continue;
			version.layout.placements = version.layout.placements.filter((placement) => placement.component !== componentId);
			if (!sameJson(version, row[which])) change[which] = version;
		}
		if (!Object.keys(change).length) continue;
		await saveMigratedVersions(scope, entries, "entry", row, change);
		const postType = await getPostType(scope, row.postTypeId);
		for (const which of ["draft", "published"] as const) {
			const changed = change[which];
			if (!changed) continue;
			const version = storedVersion(changed);
			await saveLinks(scope, row.id, which, [
				...linksIn(version.values, postType.fields),
				...layoutLinks(version.layout),
			]);
		}
	}
}
