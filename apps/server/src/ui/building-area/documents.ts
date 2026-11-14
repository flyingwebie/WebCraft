/**
 * The building area's addresses (ADR 0037 › Addresses, plan 1.4): one document is open at a time, and
 * the shell's address names it, with the place open over it and what is selected, so Back, Forward
 * and a reload all come back to the same thing.
 *
 * - The document is the path: `/_webcraft/build/page/<path>` (a page of the Site, with the page's own
 *   query), `/site-template`, `/search-template`, `/entry-template/<Post Type>?entry=<Entry>`,
 *   `/archive-template/<Post Type>`, `/component/<id>`, `/form/<id>` (`@webcraft/core`'s grammar,
 *   which the server reads too).
 * - The shell's own parameters follow: `wc-place` (`content/pages`, `media/<folder>`, …), `wc-view`
 *   (how the open place shows its list: its search, filters and sorting, as the place reads it) and
 *   `wc-select` (what is selected). They carry a prefix so they never clash with a page's own query.
 * - Opening a document or a place adds a history entry; selecting replaces the current one.
 */
import {
	BUILDING_AREA_PATH,
	type BuildingDocument,
	parseBuildingDocument,
	printBuildingDocument,
	type StandInDocument,
	standInAddress,
} from "@webcraft/core/building-addresses";
import { isCodeSelection } from "@webcraft/core/edit-paths";

export type { BuildingDocument, StandInDocument };

/** The shell's parameter for the place open over the document. */
export const PLACE_PARAMETER = "wc-place";

/** The shell's parameter for what is selected. */
export const SELECT_PARAMETER = "wc-select";

/**
 * The shell's parameter for the open place's view: its search, filters and sorting, a query string
 * the place reads and prints (`places/content/view.ts`). It goes with the place: no place, no view.
 */
export const VIEW_PARAMETER = "wc-view";

/** The longest view the address keeps: anything longer is not the shell's. */
const VIEW_MAX_LENGTH = 500;

/**
 * Everything a shell address says: the document (null when it names none), the place, the place's
 * view (null for its default view), the selection.
 */
export type ShellAddress = {
	document: BuildingDocument | null;
	place: string | null;
	view?: string | null;
	select: string | null;
};

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The places (plan 1.4): Content (Pages, a Post Type's Entries, Post Types, the Globals or one Group
 * of them), Templates, Media (a folder), Styles (its four tabs), Loops (one Loop), Components, Forms
 * (a Form and its tab).
 */
const PLACE = new RegExp(
	[
		`content/(?:pages|post-types|${ID}|globals(?:/[a-z][A-Za-z0-9_]{0,63})?)`,
		"templates",
		"components",
		`media(?:/${ID})?`,
		"styles/(?:classes|tokens|site-css|breakpoints)",
		`loops(?:/${ID})?`,
		`forms(?:/${ID}(?:/[a-z][a-z-]{0,31})?)?`,
	]
		.map((form) => `(?:${form})`)
		.join("|"),
);

/** Whether `place` names one of the building area's places, as `wc-place` holds it. */
export function isPlace(place: string): boolean {
	return new RegExp(`^(?:${PLACE.source})$`).test(place);
}

/** What a shell address (its path and query, as `location` has them) opens. */
export function readAddress(pathname: string, search: string): ShellAddress {
	const params = new URLSearchParams(search);
	const place = params.get(PLACE_PARAMETER);
	const view = params.get(VIEW_PARAMETER);
	const select = params.get(SELECT_PARAMETER);
	let documentSearch = search;
	if (place !== null || view !== null || select !== null) {
		params.delete(PLACE_PARAMETER);
		params.delete(VIEW_PARAMETER);
		params.delete(SELECT_PARAMETER);
		documentSearch = params.size ? `?${params.toString()}` : "";
	}
	const placed = place !== null && isPlace(place) ? place : null;
	const root = BUILDING_AREA_PATH.slice(0, -1);
	const document = pathname.startsWith(`${root}/`)
		? parseBuildingDocument(`${pathname.slice(root.length)}${documentSearch}`)
		: null;
	return {
		document,
		place: placed,
		view: placed !== null && view !== null && isView(view) ? view : null,
		select: select !== null && isCodeSelection(select) ? select : null,
	};
}

/** A shell address as the browser shows it: `/_webcraft/build/<document>`, then the place and the selection. */
export function printAddress(address: ShellAddress): string {
	const document = address.document ? printBuildingDocument(address.document) : "/page/";
	const extra = new URLSearchParams();
	if (address.place) extra.set(PLACE_PARAMETER, address.place);
	if (address.place && address.view) extra.set(VIEW_PARAMETER, address.view);
	if (address.select) extra.set(SELECT_PARAMETER, address.select);
	const joined = extra.size ? `${document.includes("?") ? "&" : "?"}${extra.toString()}` : "";
	return `${BUILDING_AREA_PATH.slice(0, -1)}${document}${joined}`;
}

/** Whether `view` can be a place's view: a short query string of printable characters. */
function isView(view: string): boolean {
	return view.length > 0 && view.length <= VIEW_MAX_LENGTH && /^[\x20-\x7e]+$/.test(view);
}

/** Whether two documents are the same one (an Entry template previewing another Entry is the same document). */
export function sameDocument(a: BuildingDocument | null, b: BuildingDocument | null): boolean {
	if (!a || !b) return a === b;
	if (a.kind === "entryTemplate" && b.kind === "entryTemplate") return a.postTypeId === b.postTypeId;
	return printBuildingDocument(a) === printBuildingDocument(b);
}

/** The stand-in's address for a Template or Component that no page shows. */
export function standInOf(document: StandInDocument): string {
	return standInAddress(document);
}

/** Where a document was opened from: the page the bottom bar's "Back to {page}" goes back to. */
export type CameFrom = { page: string; title: string };

/**
 * What each of the shell's history entries keeps beside its address: the page its document was
 * opened from, and whether that page is the entry just before it (so going back to it is Back).
 */
type EntryState = { webcraftBuilding: true; from: CameFrom | null; previous: boolean };

/** Why the address changed: the shell opened or replaced something, or Back / Forward went to it. */
export type AddressChange = "push" | "replace" | "pop";

/** The shell's history: what is open, and opening documents, places and selections. */
export type Documents = {
	/** What the address opens now. */
	current(): ShellAddress;
	/** The page the open document was opened from (for "Back to {page}"), if it was opened from one. */
	cameFrom(): CameFrom | null;
	/** Opens a document as the next history entry, remembering the page it was opened from. */
	open(document: BuildingDocument, from?: CameFrom | null): void;
	/** Shows another version of the open document in place (an Entry template's Entry, a page's real address). */
	replace(document: BuildingDocument): void;
	/**
	 * Opens a place over the document (null: closes it), as the next history entry, showing `view`
	 * (its default view when none).
	 */
	openPlace(place: string | null, view?: string | null): void;
	/**
	 * Changes the open place's view (its search, filters, sorting): a history entry, so Back shows the
	 * view before, or in place (`replace`, as typing in a search does).
	 */
	setView(view: string | null, how?: "push" | "replace"): void;
	/** Says what is selected (null: nothing), in place: a selection is never a history entry. */
	select(ref: string | null): void;
	/** Goes back to where the open document was opened from: Back, when that is the entry before. */
	back(): void;
	/** Calls `listener` whenever the address changes, with why. */
	subscribe(listener: (address: ShellAddress, change: AddressChange) => void): () => void;
};

/** The shell's history over the window's own (`history`, `popstate`). */
export function shellDocuments(win: Window = window): Documents {
	const listeners = new Set<(address: ShellAddress, change: AddressChange) => void>();
	const read = () => readAddress(win.location.pathname, win.location.search);
	const stateOf = (): EntryState | null => {
		const state = win.history.state as Partial<EntryState> | null;
		return state?.webcraftBuilding ? (state as EntryState) : null;
	};
	const tell = (change: AddressChange) => {
		const address = read();
		for (const listener of listeners) listener(address, change);
	};
	const write = (address: ShellAddress, how: "push" | "replace", from: CameFrom | null, previous: boolean) => {
		const next = printAddress(address);
		const state: EntryState = { webcraftBuilding: true, from, previous };
		if (how === "push") win.history.pushState(state, "", next);
		else win.history.replaceState(state, "", next);
		tell(how);
	};
	win.addEventListener("popstate", () => tell("pop"));
	return {
		current: read,
		cameFrom: () => stateOf()?.from ?? null,
		open(document, from = null) {
			write({ document, place: null, view: null, select: null }, "push", from, from !== null);
		},
		replace(document) {
			const now = read();
			const keep = sameDocument(now.document, document);
			write(
				{
					document,
					place: keep ? now.place : null,
					view: keep ? (now.view ?? null) : null,
					select: keep ? now.select : null,
				},
				"replace",
				keep ? (stateOf()?.from ?? null) : null,
				keep ? (stateOf()?.previous ?? false) : false,
			);
		},
		openPlace(place, view = null) {
			const now = read();
			const shown = place === null ? null : view;
			if (now.place === place && (now.view ?? null) === shown) return;
			write({ ...now, place, view: shown }, "push", stateOf()?.from ?? null, false);
		},
		setView(view, how = "push") {
			const now = read();
			if (now.place === null || (now.view ?? null) === view) return;
			if (how === "push") write({ ...now, view }, "push", stateOf()?.from ?? null, false);
			else {
				// In place, and nothing to tell: the place shows the view already.
				const state = stateOf() ?? { webcraftBuilding: true, from: null, previous: false };
				win.history.replaceState(state, "", printAddress({ ...now, view }));
			}
		},
		select(ref) {
			const now = read();
			if (now.select === ref) return;
			const next = printAddress({ ...now, select: ref });
			// Not a history entry, and nothing to tell: the selection is already on screen.
			win.history.replaceState(stateOf() ?? { webcraftBuilding: true, from: null, previous: false }, "", next);
		},
		back() {
			const state = stateOf();
			if (!state?.from) return;
			// The page it was opened from is the entry before: Back, which keeps Forward to the document.
			if (state.previous) win.history.back();
			else
				write(
					{ document: { kind: "page", page: state.from.page }, place: null, view: null, select: null },
					"push",
					null,
					false,
				);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
