import { isEditPageAddress } from "./paths.ts";

/**
 * The building area (ADR 0037): one shell on a Site's own address, at a path the Install keeps, that
 * shows the page in a frame of the same origin. Its addresses name the open document (ADR 0037 ›
 * Addresses): `/_webcraft/build/page/<path on the Site>` for anything that has a page,
 * `/_webcraft/build/site-template`, `/search-template`, `/entry-template/<Post Type id>?entry=<Entry id>`,
 * `/archive-template/<Post Type id>`, `/component/<id>` and `/form/<id>` for the rest.
 *
 * Nothing here imports more than the path rules, so the shell (in the browser) reads its addresses
 * with the same code as the server (`@webcraft/core/building-addresses`).
 */
export const BUILDING_AREA_PATH = "/_webcraft/build/";

/** Where the building area opens a page of the Site: `/_webcraft/build/page` and the page's path. */
export const BUILDING_AREA_PAGE_PATH = `${BUILDING_AREA_PATH}page`;

/**
 * Where a Template or Component with no page to show it on is drawn instead (the stand-in):
 * `/_webcraft/build/stand-in/<document>`, such as `/_webcraft/build/stand-in/component/<id>`.
 */
export const BUILDING_AREA_STAND_IN_PATH = `${BUILDING_AREA_PATH}stand-in`;

/** A document the building area opens: one at a time, named by its address. */
export type BuildingDocument =
	/** A page of the Site (a Page, an Entry, an archive, search results, the 404 page): its path and query. */
	| { kind: "page"; page: string }
	| { kind: "siteTemplate" }
	| { kind: "searchTemplate" }
	/** A Post Type's Entry template, previewed on one of its Entries (its newest when none is named). */
	| { kind: "entryTemplate"; postTypeId: string; entryId: string | null }
	| { kind: "archiveTemplate"; postTypeId: string }
	| { kind: "component"; componentId: string }
	| { kind: "form"; formId: string };

/** The kinds of document that are Templates or Components: what the stand-in draws. */
export type StandInDocument = Exclude<BuildingDocument, { kind: "page" } | { kind: "form" }>;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The shell's own parameter that opens a Template or Component with a Filter's element selected (the
 * admin's Filters screen, BA-34): `/archive-template/<Post Type id>?wc-filter=<Filter id>`. It is the
 * shell's, never the document's: the shell selects where the Filter is placed, then drops it.
 */
export const BUILDING_FILTER_PARAMETER = "wc-filter";

/**
 * Whether `path` is a page of the Site the building area may frame: a path as Edit mode takes it, and
 * not one of the paths the Install keeps on every Site's address (`/_…`, such as `/_webcraft/` and
 * `/_media/`), which are never a Site's pages.
 */
function isSitePageAddress(address: string): boolean {
	return isEditPageAddress(address) && !address.startsWith("/_");
}

/**
 * The document a building-area address opens: `open` is the part of its address after
 * `/_webcraft/build`, with its query (`/page/blog/fresh-bread`, `/entry-template/<id>?entry=<id>`).
 * Null for anything that names no document: another form, an id that isn't one, a path off the Site.
 * A page's query is the page's own; the other documents take no query but an Entry template's `entry`
 * and the shell's `wc-filter` (a Filter to select, `BUILDING_FILTER_PARAMETER`), which is left out.
 */
export function parseBuildingDocument(open: string): BuildingDocument | null {
	if (open.length > 4000) return null;
	if (open === "/page" || open.startsWith("/page/") || open.startsWith("/page?")) {
		const page = open.slice("/page".length);
		const address = page.startsWith("/") ? page : `/${page}`;
		return isSitePageAddress(address) ? { kind: "page", page: address } : null;
	}
	const query = open.indexOf("?");
	const path = query < 0 ? open : open.slice(0, query);
	let params: URLSearchParams;
	try {
		params = new URLSearchParams(query < 0 ? "" : open.slice(query + 1));
	} catch {
		return null;
	}
	const [empty, kind = "", id = "", ...rest] = path.split("/");
	if (empty !== "" || rest.length > 0) return null;
	// A Filter to select, once: the shell's, so it is left out of the document.
	const filter = params.getAll(BUILDING_FILTER_PARAMETER);
	if (filter.length > 1 || filter.some((each) => !ID.test(each))) return null;
	params.delete(BUILDING_FILTER_PARAMETER);
	const keys = [...params.keys()];
	if (kind === "entry-template" && ID.test(id)) {
		const entry = params.get("entry");
		if (keys.some((key) => key !== "entry") || params.getAll("entry").length > 1) return null;
		if (entry !== null && !ID.test(entry)) return null;
		return { kind: "entryTemplate", postTypeId: id, entryId: entry };
	}
	if (keys.length > 0) return null;
	if (kind === "site-template" && !id) return { kind: "siteTemplate" };
	if (kind === "search-template" && !id) return { kind: "searchTemplate" };
	if (!ID.test(id)) return null;
	if (kind === "archive-template") return { kind: "archiveTemplate", postTypeId: id };
	if (kind === "component") return { kind: "component", componentId: id };
	if (kind === "form") return { kind: "form", formId: id };
	return null;
}

/** A document's address in the building area, after `/_webcraft/build`: what `parseBuildingDocument` reads. */
export function printBuildingDocument(document: BuildingDocument): string {
	switch (document.kind) {
		case "page":
			return `/page${document.page}`;
		case "siteTemplate":
			return "/site-template";
		case "searchTemplate":
			return "/search-template";
		case "entryTemplate":
			return `/entry-template/${document.postTypeId}${document.entryId ? `?entry=${document.entryId}` : ""}`;
		case "archiveTemplate":
			return `/archive-template/${document.postTypeId}`;
		case "component":
			return `/component/${document.componentId}`;
		case "form":
			return `/form/${document.formId}`;
	}
}

/** The building area's address of a page of the Site, such as `/_webcraft/build/page/blog/fresh-bread`. */
export function buildingAreaPageAddress(page: string): string {
	return `${BUILDING_AREA_PAGE_PATH}${page}`;
}

/**
 * The page of the Site a building-area address opens (its path, with its query), or null when the
 * address opens something else or nothing.
 */
export function pageOfBuildingAddress(address: string): string | null {
	if (!address.startsWith(BUILDING_AREA_PATH)) return null;
	const document = parseBuildingDocument(address.slice(BUILDING_AREA_PATH.length - 1));
	return document?.kind === "page" ? document.page : null;
}

/**
 * Whether `open` names a document the building area opens, as an "Edit on site" link carries it: the
 * part of its address after `/_webcraft/build`, such as `/page/blog/fresh-bread` or `/component/<id>`.
 */
export function isBuildingDocument(open: string): boolean {
	return parseBuildingDocument(open) !== null;
}

/**
 * The stand-in's address for a Template or Component (`/_webcraft/build/stand-in/component/<id>`),
 * previewing an Entry template on the Entry it names.
 */
export function standInAddress(document: StandInDocument): string {
	return `${BUILDING_AREA_STAND_IN_PATH}${printBuildingDocument(document)}`;
}

/** The Template or Component a stand-in address draws, or null when it names none. */
export function standInDocumentOf(address: string): StandInDocument | null {
	if (!address.startsWith(`${BUILDING_AREA_STAND_IN_PATH}/`)) return null;
	const document = parseBuildingDocument(address.slice(BUILDING_AREA_STAND_IN_PATH.length));
	return document && document.kind !== "page" && document.kind !== "form" ? document : null;
}

/**
 * Whether `path` is a path on the admin that the building area may send the person back to: one
 * leading `/`, then printable ASCII with no backslash or fragment (a query may follow), so the logo
 * tile can never lead off the admin's own origin.
 */
export function isAdminReturnPath(path: string): boolean {
	return path.length <= 2000 && /^\/(?![/\\])[\x21-\x7e]*$/.test(path) && !/[\\#]/.test(path);
}
