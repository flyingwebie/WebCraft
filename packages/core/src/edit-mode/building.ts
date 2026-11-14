import { isEditPageAddress } from "./paths.ts";

/**
 * The building area (ADR 0037): one shell on a Site's own address, at a path the Install keeps, that
 * shows the page in a frame of the same origin. Its addresses name the open document:
 * `/_webcraft/build/page/<path on the Site>` for anything that has a page.
 */
export const BUILDING_AREA_PATH = "/_webcraft/build/";

/** Where the building area opens a page of the Site: `/_webcraft/build/page` and the page's path. */
export const BUILDING_AREA_PAGE_PATH = `${BUILDING_AREA_PATH}page`;

/** The building area's address of a page of the Site, such as `/_webcraft/build/page/blog/fresh-bread`. */
export function buildingAreaPageAddress(page: string): string {
	return `${BUILDING_AREA_PAGE_PATH}${page}`;
}

/**
 * The page of the Site a building-area address opens (its path, with its query), or null when the
 * address opens something else or nothing.
 */
export function pageOfBuildingAddress(address: string): string | null {
	if (!address.startsWith(BUILDING_AREA_PAGE_PATH)) return null;
	const page = address.slice(BUILDING_AREA_PAGE_PATH.length) || "/";
	return isEditPageAddress(page) ? page : null;
}

/**
 * Whether `open` names a document the building area opens, as an "Edit on site" link carries it: the
 * part of its address after `/_webcraft/build`, such as `/page/blog/fresh-bread`. A page of the Site
 * (with at most a query) for now; Templates and Components join it with the stand-in.
 */
export function isBuildingDocument(open: string): boolean {
	return open.length <= 4000 && pageOfBuildingAddress(`${BUILDING_AREA_PATH.slice(0, -1)}${open}`) !== null;
}

/**
 * Whether `path` is a path on the admin that the building area may send the person back to: one
 * leading `/`, then printable ASCII with no backslash or fragment (a query may follow), so the logo
 * tile can never lead off the admin's own origin.
 */
export function isAdminReturnPath(path: string): boolean {
	return path.length <= 2000 && /^\/(?![/\\])[\x21-\x7e]*$/.test(path) && !/[\\#]/.test(path);
}
