/**
 * Page sections (GLOSSARY.md, ADR 0038): Components a Page owns. A Section inserted on a Page makes
 * one (`components.create` with `pageId`), placed on that Page as any Component is, so its Prop values,
 * Co-editing, history and Site transfer go through the Page layout's own machinery. It is never
 * listed, never placed anywhere else, and goes with its Page:
 *
 * - **Publishing** the Page publishes the Sections its layout places that have a Draft to publish
 *   (`publishPageSections`), in the same transaction, as one Publish item: the Page's. Publish all,
 *   Scheduled publishes and Reviews see a Page whose Sections changed as a changed Page
 *   (`pageSectionDrafts`, `pageSectionsChanged`).
 * - **Removing** a Section's Placement keeps the Component while the Page's Draft or published layout
 *   may still need it (Undo puts the Placement back, and the published page shows it until the next
 *   publish); the Page's next publish deletes the Sections neither places (`deleteUnplacedSections`).
 * - **Deleting** the Page deletes its Sections (`deletePageSections`; the foreign key cascades too).
 *
 * "Make reusable Component" (`makeComponentReusable`) turns one into a library Component.
 */
import { components, entries } from "@webcraft/db/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { componentScriptStates, retireComponentScript } from "./component-scripts.ts";
import { draftVersion, sameJson } from "./json.ts";
import { type EntryVersion, storedVersion } from "./values.ts";

type ComponentRow = typeof components.$inferSelect;

/** The Components a version of a Page places, by id. */
function placedIn(version: EntryVersion | null | undefined): Set<string> {
	return new Set((version?.layout?.placements ?? []).map((placement) => placement.component));
}

/** Whether a Section has something to publish: never published, its Draft changed, or its Component script's. */
function unpublished(row: ComponentRow, scripts: Map<string, { changed: boolean }>): boolean {
	return row.published === null || !sameJson(row.draft, row.published) || scripts.get(row.id)?.changed === true;
}

/** The Sections of a Page that `version` places and have something to publish: they go live with it. */
export async function sectionsToPublish(scope: SiteScope, pageId: string, version: EntryVersion): Promise<string[]> {
	const placed = placedIn(version);
	if (placed.size === 0) return [];
	const rows = (await scope.select(components, eq(components.pageId, pageId))).filter((row) => placed.has(row.id));
	const scripts = await componentScriptStates(
		scope,
		rows.map((row) => row.id),
	);
	return rows.filter((row) => unpublished(row, scripts)).map((row) => row.id);
}

/** Whether a Page's Draft places a Section with something to publish (Reviews: a changed Page). */
export async function pageSectionsChanged(scope: SiteScope, pageId: string): Promise<boolean> {
	const row = await scope.first(entries, eq(entries.id, pageId));
	if (!row) return false;
	return (await sectionsToPublish(scope, pageId, storedVersion(row.draft))).length > 0;
}

/**
 * Deletes the Sections of a Page that neither its Draft nor its published version places: called
 * once the Page is published, inside its transaction (which holds the Site's Component lock).
 */
export async function deleteUnplacedSections(
	scope: SiteScope,
	pageId: string,
	draft: EntryVersion,
	published: EntryVersion,
): Promise<void> {
	const kept = new Set([...placedIn(draft), ...placedIn(published)]);
	const gone = (await scope.select(components, eq(components.pageId, pageId))).filter((row) => !kept.has(row.id));
	await deleteSections(scope, gone);
}

/** Deletes every Section of a Page, before the Page goes (inside its transaction, with the Component lock). */
export async function deletePageSections(scope: SiteScope, pageId: string): Promise<void> {
	await deleteSections(scope, await scope.select(components, eq(components.pageId, pageId)));
}

async function deleteSections(scope: SiteScope, rows: readonly ComponentRow[]): Promise<void> {
	if (rows.length === 0) return;
	// A published Component script stays reachable for pages loaded before, as deleting any Component keeps it.
	for (const row of rows) await retireComponentScript(scope, row.id);
	await scope.delete(
		components,
		inArray(
			components.id,
			rows.map((row) => row.id),
		),
	);
	for (const row of rows) await scope.audit("component.delete", { componentId: row.id, pageId: row.pageId });
}

/** What Publish all knows of a Page's Sections: whether they changed, who changed them last, and their Drafts' version. */
export type PageSectionDrafts = {
	changedAt: Date;
	updatedBy: string | null;
	updatedVia: string | null;
	/** The version of the Sections' Drafts, which a Publish all confirmation holds with the Page's. */
	version: string;
};

/**
 * Every Page whose Draft places a Section with something to publish, by the Page's id: Publish all
 * lists it as a changed Page, and its confirmation holds the Sections' Drafts too.
 */
export async function pageSectionDrafts(scope: SiteScope): Promise<Map<string, PageSectionDrafts>> {
	const rows = await scope.select(components, isNotNull(components.pageId));
	if (rows.length === 0) return new Map();
	const pages = await scope.select(entries, inArray(entries.id, [...new Set(rows.map((row) => row.pageId as string))]));
	const drafts = new Map(pages.map((page) => [page.id, storedVersion(page.draft)]));
	const scripts = await componentScriptStates(
		scope,
		rows.map((row) => row.id),
	);
	const byPage = new Map<string, ComponentRow[]>();
	for (const row of rows) {
		const pageId = row.pageId as string;
		if (!placedIn(drafts.get(pageId)).has(row.id) || !unpublished(row, scripts)) continue;
		byPage.set(pageId, [...(byPage.get(pageId) ?? []), row]);
	}
	const result = new Map<string, PageSectionDrafts>();
	for (const [pageId, sections] of byPage) {
		const newest = sections.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
		result.set(pageId, {
			changedAt: newest.updatedAt,
			updatedBy: newest.updatedBy,
			updatedVia: newest.updatedVia,
			version: draftVersion(
				sections
					.map((row) => ({ id: row.id, draft: row.draft, script: scripts.get(row.id)?.version ?? null }))
					.sort((a, b) => a.id.localeCompare(b.id)),
			),
		});
	}
	return result;
}

/** The Pages owning Sections among `pageIds`: whose publish may change the stylesheet. */
export async function pagesWithSections(scope: SiteScope, pageIds: readonly string[]): Promise<boolean> {
	if (pageIds.length === 0) return false;
	return (
		(await scope.select(components, and(isNotNull(components.pageId), inArray(components.pageId, [...pageIds]))))
			.length > 0
	);
}
