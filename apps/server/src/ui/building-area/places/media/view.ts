import { MEDIA_KINDS, type MediaKind } from "@webcraft/core/media-kinds";

/**
 * Where the Media place is and how it shows its files (SPEC 8, plan BA-22), as the shell's address
 * keeps them: the place (`media`, `media/unfiled`, `media/trash`, `media/<folder>`) and its view
 * (`wc-view`, a short query string: the search, the kind, the grid, the file open and the language its
 * texts are shown in). Back returns to what was shown before; a reload shows the same. Pure: no React.
 */

/** What part of the library the place shows. */
export type MediaPart =
	| { kind: "all" }
	| { kind: "unfiled" }
	| { kind: "trash" }
	| { kind: "folder"; folderId: string };

/** How the files show: a list (the default) or a masonry grid of pictures. */
export type MediaLayout = "list" | "grid";

export type MediaView = {
	q: string;
	kind: MediaKind | null;
	layout: MediaLayout;
	/** The file open in place, with its details. */
	file: string | null;
	/** The language the open file's texts are shown in; null for the Site's Default language. */
	language: string | null;
};

/** The longest search the address keeps. */
const SEARCH_MAX = 200;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The part of the library a Media place's address names (`media` and anything unknown: All files). */
export function partOf(place: string): MediaPart {
	const rest = place.slice("media/".length);
	if (place === "media" || !place.startsWith("media/")) return { kind: "all" };
	if (rest === "unfiled") return { kind: "unfiled" };
	if (rest === "trash") return { kind: "trash" };
	return ID.test(rest) ? { kind: "folder", folderId: rest } : { kind: "all" };
}

/** A part of the library as the address names it. */
export function placeOf(part: MediaPart): string {
	switch (part.kind) {
		case "all":
			return "media";
		case "unfiled":
			return "media/unfiled";
		case "trash":
			return "media/trash";
		case "folder":
			return `media/${part.folderId}`;
	}
}

/** The view when the address says nothing: every kind, as a list, nothing open. */
export function defaultView(): MediaView {
	return { q: "", kind: null, layout: "list", file: null, language: null };
}

/**
 * Reads a view from the address's `wc-view` (null: the default); anything it doesn't know is left out.
 * `layout` is the layout when the address names none: the one the person last chose (FX-03).
 */
export function readView(view: string | null, layout: MediaLayout = "list"): MediaView {
	const shown = { ...defaultView(), layout };
	if (!view) return shown;
	const params = new URLSearchParams(view);
	const q = params.get("q");
	if (q) shown.q = q.slice(0, SEARCH_MAX);
	const kind = params.get("kind");
	if (kind && (MEDIA_KINDS as readonly string[]).includes(kind)) shown.kind = kind as MediaKind;
	const named = params.get("view");
	if (named === "grid" || named === "list") shown.layout = named;
	const file = params.get("file");
	if (file && ID.test(file)) shown.file = file;
	const language = params.get("language");
	if (language && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)) shown.language = language;
	return shown;
}

/**
 * A view as the address keeps it: only what differs from the default, or null when nothing does. The
 * layout is named when it isn't `layout`, the one the address means when it names none.
 */
export function printView(view: MediaView, layout: MediaLayout = "list"): string | null {
	const params = new URLSearchParams();
	if (view.q.trim()) params.set("q", view.q.slice(0, SEARCH_MAX));
	if (view.kind) params.set("kind", view.kind);
	if (view.layout !== layout) params.set("view", view.layout);
	if (view.file) {
		params.set("file", view.file);
		if (view.language) params.set("language", view.language);
	}
	return params.size ? params.toString() : null;
}

/**
 * The view kept when the place shows another part of the library: the search, kind and layout go
 * along (as the admin's folders keep them); an open file doesn't. The Trash keeps only the layout.
 */
export function viewFor(part: MediaPart, view: MediaView): MediaView {
	if (part.kind === "trash") return { ...defaultView(), layout: view.layout };
	return { ...view, file: null, language: null };
}

/** The `media.list` query a part and a view ask for. */
export function listQuery(
	part: MediaPart,
	view: MediaView,
): { trash?: boolean; folderId?: string; search?: string; kind?: MediaKind } {
	const search = view.q.trim() || undefined;
	const kind = view.kind ?? undefined;
	switch (part.kind) {
		case "trash":
			return { trash: true, search, kind };
		case "unfiled":
			return { folderId: "none", search, kind };
		case "folder":
			return { folderId: part.folderId, search, kind };
		case "all":
			return { search, kind };
	}
}

const LAYOUT_KEYS = { place: "webcraft.building.mediaLayout", picker: "webcraft.building.mediaPickerLayout" } as const;

/**
 * The layout the person last chose for the place or the picker (kept in this browser, as the code
 * panes' wrapping is), or `fallback` when they never chose one or it can't be read.
 */
export function rememberedLayout(where: keyof typeof LAYOUT_KEYS, fallback: MediaLayout): MediaLayout {
	try {
		const stored = globalThis.localStorage?.getItem(LAYOUT_KEYS[where]);
		return stored === "grid" || stored === "list" ? stored : fallback;
	} catch {
		return fallback;
	}
}

/** Keeps the layout the person chose, for the next time the place or the picker opens. */
export function rememberLayout(where: keyof typeof LAYOUT_KEYS, layout: MediaLayout): void {
	try {
		globalThis.localStorage?.setItem(LAYOUT_KEYS[where], layout);
	} catch {
		// Storage refused (a private window): the choice lasts while the page does.
	}
}
