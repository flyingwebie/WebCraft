import type { MediaChange, MediaItem, MediaLibrary } from "../media/library.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import type { EditSession } from "./index.ts";

/**
 * The image popover's view of the Site's Media library (GLOSSARY.md › Focal point): the same library,
 * permissions and limits as the admin's Media screen. Choosing an image for a region is a change to
 * the Draft (`saveImage`); alt text and the Focal point belong to the Media item itself, shared by
 * every page that shows it, and change at once with no Draft, as they do in the library.
 */

/** An image as the image popover shows it. */
export type EditMediaItem = {
	id: string;
	fileName: string;
	title: string | null;
	/** Its alt text in the language asked for (the Default language's when it has none of its own). */
	alt: string | null;
	width: number | null;
	height: number | null;
	status: MediaItem["status"];
	/** The original, on the Site's own domain; null until the worker has cleaned it. */
	url: string | null;
	/** A small file to show it in a list: its narrowest WebP of at least 320 pixels, else the original. */
	thumbnail: string | null;
	focalPoint: MediaItem["focalPoint"];
	/** Whether the person may change its alt text and Focal point: their own upload, or every file for Editors and up. */
	canEdit: boolean;
	/** Whether the worker is still cleaning a new file for it (Replace file); the current one shows meanwhile. */
	replacing: boolean;
};

/** Which images to list: matching a search, in a folder (`none`: in no folder), a page at a time. */
export type EditMediaQuery = { search?: string; folderId?: string; offset?: number; language?: string };

/** How many images the popover lists at a time. */
export const EDIT_MEDIA_PAGE = 30;

/** The narrowest variant worth showing in a list. */
const THUMBNAIL_WIDTH = 320;

export function editMediaItem(item: MediaItem): EditMediaItem {
	const thumbnail = item.variants
		.filter((variant) => variant.format === "webp" && variant.width >= THUMBNAIL_WIDTH)
		.sort((a, b) => a.width - b.width)[0];
	return {
		id: item.id,
		fileName: item.fileName,
		title: item.title,
		alt: item.alt,
		width: item.width,
		height: item.height,
		status: item.status,
		url: item.url,
		thumbnail: thumbnail?.url ?? item.url,
		focalPoint: item.focalPoint,
		canEdit: item.canEdit,
		replacing: item.replacing,
	};
}

export type EditMediaDeps = { data: DataLayer; media: MediaLibrary };

/** The Site's images out of the Trash, newest first, a page at a time, with the library's folders. */
export async function libraryImages(
	deps: EditMediaDeps,
	session: EditSession,
	query: EditMediaQuery,
): Promise<{ items: EditMediaItem[]; total: number; folders: { id: string; name: string; count: number }[] }> {
	const listed = await deps.media.list(session.scope, {
		kind: "image",
		search: query.search,
		folderId: query.folderId,
		language: query.language,
		offset: query.offset,
		limit: EDIT_MEDIA_PAGE,
	});
	const { folders } = await deps.media.folders.list(session.scope);
	return {
		items: listed.items.map(editMediaItem),
		total: listed.total,
		folders: folders.map(({ id, name, count }) => ({ id, name, count })),
	};
}

/** One image of the Site's library, its alt text in a language, and whether alt text can be suggested. */
export async function libraryImage(
	deps: EditMediaDeps,
	session: EditSession,
	mediaId: string,
	language?: string,
): Promise<{ media: EditMediaItem; altTextSuggestions: boolean }> {
	const item = await deps.media.get(session.scope, mediaId, language);
	const workspace = await deps.data.workspace(session.access, session.scope.workspace.id, "workspace.view");
	const { altTextSuggestions } = await deps.media.overview(session.scope, workspace);
	return { media: editMediaItem(item), altTextSuggestions };
}

/**
 * Changes an image's alt text (in a language) or its Focal point, as the library does: the person's
 * own upload, or every file with `media.manage`; live at once on every page showing it.
 */
export async function changeImage(
	deps: EditMediaDeps,
	session: EditSession,
	mediaId: string,
	change: Pick<MediaChange, "language" | "alt" | "focalPoint">,
): Promise<{ media: EditMediaItem }> {
	const scope = await uploading(deps, session);
	return { media: editMediaItem(await deps.media.update(scope, mediaId, change)) };
}

/** An AI provider's alt text for an image, in a language; nothing is saved. */
export async function suggestImageAlt(
	deps: EditMediaDeps,
	session: EditSession,
	mediaId: string,
	language?: string,
): Promise<{ alt: string }> {
	const scope = await uploading(deps, session);
	return { alt: await deps.media.suggestAltText(scope, mediaId, language) };
}

/**
 * Uploads a file to the Site's library as the admin's Media screen does: its type from its bytes, the
 * Install's largest file, the Workspace's quota; an image is cleaned by the worker before it shows.
 */
export async function uploadImage(
	deps: EditMediaDeps,
	session: EditSession,
	upload: { fileName: string; data: Uint8Array; folderId?: string | null },
): Promise<{ media: EditMediaItem }> {
	const scope = await uploading(deps, session);
	return { media: editMediaItem(await deps.media.upload(scope, upload)) };
}

/** The Site opened for the person with `media.upload`, which every role on a Site holds. */
function uploading(deps: EditMediaDeps, session: EditSession): Promise<SiteScope> {
	return deps.data.site(session.access, session.scope.site.id, "media.upload");
}
