import type { BuildingAreaApiClient } from "@webcraft/api";

import { type BuildingDocument, standInOf } from "./documents.ts";

/**
 * Where the frame shows an open document (ADR 0037 › Addresses, plan 1.4):
 * - a page at its own path;
 * - a Template on a page that shows it when there is one (an Entry template on its Entry's page, the
 *   Site template on the home page, Search results on the search page, an Archive template on its
 *   archive), else on the stand-in;
 * - a Component on a page that shows it, else on the stand-in;
 * - a Form in the Forms place, which comes later.
 */
export type Shown =
	/** The frame shows `frame` (a path on the Site, or the stand-in's address). */
	| { status: "shown"; frame: string; standIn: boolean; entryId: string | null }
	/** The address names nothing this person can open on this Site. */
	| { status: "missing" }
	/** A Form: its place isn't built yet. */
	| { status: "later" };

/**
 * Finds where the frame shows a document: Templates and Components are looked up with the visual
 * builder's own `builder.destinations` (the pages that really render them, rendered to check),
 * through the Management API on the Site's address. A refusal (another Site's id, no `structure.edit`)
 * means there is nothing to open.
 */
export async function whereShown(
	api: BuildingAreaApiClient,
	siteId: string,
	document: BuildingDocument,
): Promise<Shown> {
	if (document.kind === "page") return { status: "shown", frame: document.page, standIn: false, entryId: null };
	if (document.kind === "form") return { status: "later" };
	const target =
		document.kind === "entryTemplate" || document.kind === "archiveTemplate"
			? { kind: document.kind, postTypeId: document.postTypeId }
			: document.kind === "component"
				? { kind: document.kind, componentId: document.componentId }
				: { kind: document.kind };
	const entryId = document.kind === "entryTemplate" ? document.entryId : null;
	try {
		const found = await api.builder.destinations({ siteId, target, ...(entryId ? { entryId } : {}) });
		const page = found.pages[0];
		if (page) return { status: "shown", frame: page.path, standIn: false, entryId: found.entryId };
		const standIn = document.kind === "entryTemplate" ? { ...document, entryId: found.entryId ?? null } : document;
		return { status: "shown", frame: standInOf(standIn), standIn: true, entryId: found.entryId };
	} catch {
		return { status: "missing" };
	}
}
