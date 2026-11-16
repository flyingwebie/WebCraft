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
 *   `wc-filter` (a Filter's id, from the admin's Filters screen) asks for the element placing that
 *   Filter to be selected once the page shows it; the selection then takes its place (BA-34).
 *   `wc-element` (an element's id in the document's markup, from the admin's Checks) does the same for
 *   that element (BA-28).
 * - Opening a document or a place adds a history entry; selecting replaces the current one.
 * - Each document remembers what was selected in it for the shell's life, so switching to another
 *   document and coming back (from the switcher, "Back to {page}", Back) selects it again (BA-34).
 */
import {
	BUILDING_AREA_PATH,
	BUILDING_ELEMENT_PARAMETER,
	BUILDING_FILTER_PARAMETER,
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

/** The shell's parameter for a Filter whose element is to be selected (BA-34): read once, then the selection. */
export const FILTER_PARAMETER = BUILDING_FILTER_PARAMETER;

/** The shell's parameter for an element to be selected by its id (BA-28): read once, then the selection. */
export const ELEMENT_PARAMETER = BUILDING_ELEMENT_PARAMETER;

/**
 * The shell's parameter for the open place's view: its search, filters and sorting, a query string
 * the place reads and prints (`places/content/view.ts`). It goes with the place: no place, no view.
 */
export const VIEW_PARAMETER = "wc-view";

/** The longest view the address keeps: anything longer is not the shell's. */
const VIEW_MAX_LENGTH = 500;

/**
 * Everything a shell address says: the document (null when it names none), the place, the place's
 * view (null for its default view), the selection, and a Filter whose element is to be selected.
 */
export type ShellAddress = {
	document: BuildingDocument | null;
	place: string | null;
	view?: string | null;
	select: string | null;
	filter?: string | null;
	element?: string | null;
};

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const FILTER_ID = new RegExp(`^${ID}$`);

const ELEMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The places (plan 1.4): Content (Pages, a Post Type's Entries, Fields or Settings, Post Types, the
 * Globals or one Group of them), Templates, Media (a folder, Unfiled or the Trash), Styles (its four
 * tabs), Loops (one Loop), Components, Forms (a Form and its tab).
 */
const PLACE = new RegExp(
	[
		`content/(?:pages|post-types|${ID}(?:/(?:fields|settings))?|globals(?:/[a-z][A-Za-z0-9_]{0,63})?)`,
		"templates",
		"components",
		`media(?:/(?:${ID}|unfiled|trash))?`,
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
	const filter = params.get(FILTER_PARAMETER);
	const element = params.get(ELEMENT_PARAMETER);
	let documentSearch = search;
	if (place !== null || view !== null || select !== null || filter !== null || element !== null) {
		params.delete(PLACE_PARAMETER);
		params.delete(VIEW_PARAMETER);
		params.delete(SELECT_PARAMETER);
		params.delete(FILTER_PARAMETER);
		params.delete(ELEMENT_PARAMETER);
		documentSearch = params.size ? `?${params.toString()}` : "";
	}
	const placed = place !== null && isPlace(place) ? place : null;
	const root = BUILDING_AREA_PATH.slice(0, -1);
	const document = pathname.startsWith(`${root}/`)
		? parseBuildingDocument(`${pathname.slice(root.length)}${documentSearch}`)
		: null;
	// The view only when there is one: an address with none reads as it did before views.
	const viewed = placed !== null && view !== null && isView(view) ? view : null;
	// A Filter to select, likewise only when there is one.
	const filtered = filter !== null && FILTER_ID.test(filter) ? filter : null;
	const chosen = element !== null && ELEMENT_ID.test(element) ? element : null;
	return {
		document,
		place: placed,
		...(viewed ? { view: viewed } : {}),
		select: select !== null && isCodeSelection(select) ? select : null,
		...(filtered ? { filter: filtered } : {}),
		...(chosen ? { element: chosen } : {}),
	};
}

/** A shell address as the browser shows it: `/_webcraft/build/<document>`, then the place and the selection. */
export function printAddress(address: ShellAddress): string {
	const document = address.document ? printBuildingDocument(address.document) : "/page/";
	const extra = new URLSearchParams();
	if (address.place) extra.set(PLACE_PARAMETER, address.place);
	if (address.place && address.view) extra.set(VIEW_PARAMETER, address.view);
	if (address.select) extra.set(SELECT_PARAMETER, address.select);
	if (address.filter) extra.set(FILTER_PARAMETER, address.filter);
	if (address.element) extra.set(ELEMENT_PARAMETER, address.element);
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
	return documentKey(a) === documentKey(b);
}

/** What tells one document from another: its address, an Entry template's without the Entry it previews. */
export function documentKey(document: BuildingDocument): string {
	return document.kind === "entryTemplate" ? `/entry-template/${document.postTypeId}` : printBuildingDocument(document);
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
	/**
	 * Shows another version of the open document in place (an Entry template's Entry, a page's real
	 * address); with `place`, that place open over it (a Form's address opens the Forms place, BA-27).
	 */
	replace(document: BuildingDocument, place?: string): void;
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
	/**
	 * Says what is selected (null: nothing), in place: a selection is never a history entry. The open
	 * document remembers it, and a Filter the address asked to select is done with.
	 */
	select(ref: string | null): void;
	/** What was last selected in a document in this tab, if anything. */
	remembered(document: BuildingDocument): string | null;
	/** Goes back to where the open document was opened from: Back, when that is the entry before. */
	back(): void;
	/** Calls `listener` whenever the address changes, with why. */
	subscribe(listener: (address: ShellAddress, change: AddressChange) => void): () => void;
};

/**
 * Puts another address in place of the current one without telling anyone (FX-04): Staff's shell and
 * client editing hand the tab to each other ("View as a client" and back), and the shell drawn next
 * reads its document from the address as it starts.
 */
export function swapAddress(address: string, win: Window = window): void {
	const state: EntryState = { webcraftBuilding: true, from: null, previous: false };
	win.history.replaceState(state, "", address);
}

/** The shell's history over the window's own (`history`, `popstate`). */
export function shellDocuments(win: Window = window): Documents {
	const listeners = new Set<(address: ShellAddress, change: AddressChange) => void>();
	const read = () => readAddress(win.location.pathname, win.location.search);
	// What was selected in each document opened in this tab, by `documentKey`.
	const selected = new Map<string, string>();
	const remember = (address: ShellAddress) => {
		if (!address.document) return;
		if (address.select) selected.set(documentKey(address.document), address.select);
		else selected.delete(documentKey(address.document));
	};
	const recall = (document: BuildingDocument) => selected.get(documentKey(document)) ?? null;
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
			write({ document, place: null, view: null, select: recall(document) }, "push", from, from !== null);
		},
		replace(document, place) {
			const now = read();
			const keep = sameDocument(now.document, document);
			write(
				{
					document,
					place: place ?? (keep ? now.place : null),
					view: !place && keep ? (now.view ?? null) : null,
					select: keep ? now.select : null,
					filter: keep ? (now.filter ?? null) : null,
					element: keep ? (now.element ?? null) : null,
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
				// In place: not a history entry, but the place draws its view from the address.
				const state = stateOf() ?? { webcraftBuilding: true, from: null, previous: false };
				win.history.replaceState(state, "", printAddress({ ...now, view }));
				tell("replace");
			}
		},
		select(ref) {
			const now = read();
			// Nothing selected yet while a Filter or an element waits to be: it stays asked for.
			const asked = Boolean(now.filter || now.element);
			if (now.select === ref && (!asked || ref === null)) return;
			remember({ ...now, select: ref });
			const next = printAddress({ ...now, select: ref, filter: null, element: null });
			// Not a history entry, and nothing to tell: the selection is already on screen (but a Filter
			// or an element the address asked for is done with, which those following the address learn).
			win.history.replaceState(stateOf() ?? { webcraftBuilding: true, from: null, previous: false }, "", next);
			if (asked) tell("replace");
		},
		back() {
			const state = stateOf();
			if (!state?.from) return;
			// The page it was opened from is the entry before: Back, which keeps Forward to the document.
			if (state.previous) win.history.back();
			else {
				const page: BuildingDocument = { kind: "page", page: state.from.page };
				write({ document: page, place: null, view: null, select: recall(page) }, "push", null, false);
			}
		},
		remembered: recall,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
