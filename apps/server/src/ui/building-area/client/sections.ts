import type { FieldDefinition } from "@webcraft/core";
import { type DraftClient, type Json, reverseChange } from "@webcraft/core/draft-document";

import type { BarKit, SharedDraft } from "../../../site/edit-bar/kit.ts";
import { editorHistory, type HistoryLocation } from "../../builder/editor-history.ts";
import type { MediaItem } from "../../media/preview.ts";
import {
	FOOTER_ROW,
	HEADER_ROW,
	type LayoutAction,
	type LayoutRefusal,
	type LayoutState,
	type LayoutStep,
	type PageLayoutController,
	pageLayoutController,
} from "../../page-layouts/controller.ts";
import { type EditRequests, fill, type PageState, type Words } from "../api.ts";
import type { SavingStatus } from "../canvas/regions.ts";
import { draftResource } from "../editing/drafts.ts";
import type { ClientEditing, ClientMode } from "./marks.ts";

/**
 * Sections for a Member (SPEC 13.3 and 13.4, BA-17; `client/06`, `client/07`): a Page's Page layout,
 * arranged where the Site lets its Members arrange. Its rules and writes are the Page layout
 * controller's (`ui/page-layouts/controller.ts`, the editing bar's), given the shell's parts instead of
 * the bar's (`kit`, below): the frame's page, the edit requests (`layout/get`, `layout/save`), the
 * page's Entry's shared Draft (Props typed in, Co-editing) and the shell's live region. So what may
 * move where, locks, Allowed components, Props kept as typed while others change the page, and every
 * refusal stay what they were.
 *
 * What this adds for the client shell:
 * - the side panel's views: the list of sections (`list`), a section's Props (`settings`) and the
 *   picker of Allowed components (`add`), with where a new section goes (`addAfter`);
 * - the section chosen as a whole on the page (by its edge or its name, or from the list): its name
 *   and bar inside its top edge (`SectionBar.tsx`); the section under the pointer, named;
 * - "+ Add section" near the boundary between two sections, and the place a card of the picker would
 *   land, shown in the page while it is pointed at;
 * - Remove asks nothing: a toast offers Undo for 8 s (`removed`);
 * - each finished action is a step of the tab's Undo history (`editorHistory`), taken back through
 *   the page's Entry's shared Draft as typed text is;
 * - the Draft's state beside Publish follows each save; Preview hides what is hidden.
 *
 * It wraps the client editing (`marks.ts`) to see the page's events first, as that wraps the page
 * editing (BA-07): `wrap(editing)` is what the frame is given.
 */
export type MemberSections = {
	/** The client editing, with the sections' share of the page's events. */
	wrap(editing: ClientEditing): ClientEditing;
	snapshot(): SectionsSnapshot;
	/** Called when the snapshot changes. Answers how to stop. */
	subscribe(listener: () => void): () => void;
	/** Called when the page moved under the shell (scrolled, resized, drawn again): what is drawn over it follows. */
	onMove(listener: () => void): () => void;
	/** Where an element of the page is on the shell's window (null: not shown). */
	boxOf(element: Element): DOMRect | null;
	/** The page's elements of a section (a Component may draw more than one at its top level). */
	elementsOf(id: string): HTMLElement[];
	/** A section's box on the shell's window (all its elements), or null when the page doesn't show it. */
	sectionBox(id: string): DOMRect | null;
	/** The frame's box on the shell's window, where marks may be drawn. */
	frameBox(): DOMRect | null;
	/** Chooses a row (a section, or the header or footer); `onPage` draws its bar on the page. */
	select(id: string | null, options?: { onPage?: boolean; focus?: boolean }): void;
	/** Moves up or down, duplicates, hides or shows a section (refused ones say why). */
	act(action: "moveUp" | "moveDown" | "duplicate" | "hide", id?: string | null): void;
	/** Removes a section; nothing is asked, a toast offers Undo. */
	remove(id?: string | null): void;
	/** The toast's Undo: the removal is taken back. */
	undoRemove(): void;
	dismissRemoved(): void;
	/** Why an action can't be done on a section now, or null. */
	refusal(action: LayoutAction, id?: string | null): LayoutRefusal | null;
	/** Picks the chosen section up to move it with the keys, puts it down, or puts it back. */
	grab(change: "pick" | "drop" | "cancel"): void;
	/** Moves a section to `to` (its index among the sections once moved), as a drag drops it. */
	drop(from: number, to: number): void;
	/** Opens a view of the side panel: the list, a section's settings, or the picker after a row. */
	view(view: SectionsView, options?: { after?: string | null; focus?: boolean }): void;
	/** Adds a section of an Allowed component where the picker was opened for. */
	add(componentId: string): void;
	/** A card of the picker is pointed at (or has focus): the page shows where it would land. */
	point(componentId: string | null): void;
	/** The "+ Add section" line is under the pointer: kept while it is. */
	holdBoundary(held: boolean): void;
	/** A Prop of a section: its value now (as typed, others' changes in), a change, and finishing it. */
	values(id: string): Record<string, unknown>;
	prop(id: string, field: FieldDefinition, value: unknown, finish: boolean): void;
	finishProps(id: string): void;
	/** Registers what to finish when the person moves on (another section, the panel closing). */
	finishWith(flush: () => void): () => void;
	/** A media Prop's file, for its name and picture. */
	media(id: string): Promise<MediaItem | null>;
	/** The side panel closed: what was typed is finished, a picked-up section put down. */
	closed(): void;
	destroy(): void;
};

export type SectionsView = "list" | "settings" | "add";

/** An Allowed component, as the picker shows it. */
export type AllowedComponent = { id: string; name: string; props: FieldDefinition[]; kind: SectionKind };

/** What a section looks like, for its small picture: drawn as a sketch from what its Props hold. */
export type SectionKind = "photoWords" | "grid" | "banner" | "twoCol" | "plain";

/** One row of the Sections list: a section, or the Site template's header or footer. */
export type SectionRow = {
	id: string;
	kind: "header" | "footer" | "section";
	/** Its name in the list: the Component and its first words ("Hero · Fresh from our ovens"). */
	label: string;
	/** The Component's name, on the page's chip. */
	name: string;
	locked: boolean;
	hidden: boolean;
	sketch: SectionKind;
};

/** Where "+ Add section" is: between the row `after` (`HEADER_ROW` at the top) and the next one. */
export type Boundary = {
	after: string;
	next: string | null;
	/** Where the next section starts, and where the one before ends, in the page's own pixels. */
	y: number;
	from: number;
};

export type SectionsSnapshot = {
	/** `none`: the page isn't a Page the person may arrange now (Preview too); `loading` until it is read. */
	status: "none" | "loading" | "ready";
	rows: readonly SectionRow[];
	/** How many sections the page has (the header and footer aside). */
	count: number;
	selected: string | null;
	/** The chosen section's name and bar are drawn on the page. */
	onPage: boolean;
	view: SectionsView;
	/** Where the picker adds (`HEADER_ROW`, a section's id, or null for the end). */
	addAfter: string | null;
	components: readonly AllowedComponent[];
	/** The card pointed at in the picker. */
	pointing: string | null;
	/** The section under the pointer in the page. */
	hovered: string | null;
	boundary: Boundary | null;
	removed: { key: number; label: string } | null;
	grabbed: boolean;
	busy: boolean;
	/** Bumped when focus should go to the chosen row (or the view's first control). */
	focusRequest: number;
	/** What a section's Props need: the page's languages and the Entries a Relationship may point at. */
	language: string;
	defaultLanguage: string;
	relationships: LayoutState["relationships"];
	/** Each section's Props (by section id). */
	props: Readonly<Record<string, readonly FieldDefinition[]>>;
	/** Changes when the page's sections were drawn again (a picture of the page to measure again). */
	drawn: number;
};

/** How long the toast after a removal offers Undo (`client-flows/05`: 8 s with Undo). */
export const REMOVED_FOR_MS = 8000;

/** How near a boundary between two sections the pointer brings "+ Add section", in the page's pixels. */
const BOUNDARY_REACH = 16;

/** The place a card would land, while it is pointed at: an element of the shell's own making in the page. */
const LANDING = "data-wc-section-landing";

/** The Site template's parts outside the page's own content: the header and footer rows. */
const SITE_HEADER = "header, [role='banner']";
const SITE_FOOTER = "footer, [role='contentinfo']";

/** A section's root elements in the page: one per element its Component draws at the top. */
const PLACEMENT = "[data-wc-page-placement]";

/** A text Prop typed in place on the page (the controller makes it editable). */
export const PLACEMENT_PROP = '[data-wc-placement-prop][contenteditable="true"]';

/** What a section's Props suggest it shows, for its picture and its group in the picker. */
export function kindOf(props: readonly FieldDefinition[]): SectionKind {
	const types = new Set(props.map((prop) => prop.type));
	if (types.has("repeater")) return "grid";
	if (types.has("media")) return "photoWords";
	if (types.has("link")) return "banner";
	if (props.filter((prop) => prop.type === "text" || prop.type === "richText").length > 1) return "twoCol";
	return "plain";
}

/** The marks the page's own regions can't be told from: the region a pointer is over, a Member's way. */
type Edit = ClientEditing;

export function memberSections(options: {
	token: string;
	siteId: string;
	words: Words;
	request: EditRequests;
	announce(text: string, urgent?: boolean): void;
	/** The page's Draft changed: its state is read again (the Draft state, Publish's count). */
	refresh(): void;
	/** Saving to the Draft started, ended, or failed. */
	saving(status: SavingStatus): void;
	/** Takes back the person's last step (the toast's Undo). */
	undo(): void;
	/** The page's title, for the Undo history's "on {page}". */
	title(): string;
}): MemberSections {
	const { words, announce } = options;
	const said = words.sections;
	const listeners = new Set<() => void>();
	const flushers = new Set<() => void>();
	const history = editorHistory();

	let wrapped: Edit | null = null;
	let frame: HTMLIFrameElement | null = null;
	let doc: Document | null = null;
	let mode: ClientMode = "edit";
	let pageState: PageState | null = null;
	/** The page read for the frame's page: its Entry, once the page is parsed and its layout read. */
	let page: {
		doc: Document;
		entryId: string;
		controller: PageLayoutController | null;
		shared: ReturnType<typeof openShared> | null;
		stops: (() => void)[];
		loading: boolean;
	} | null = null;
	let parsed: Document | null = null;

	let view: SectionsView = "list";
	let addAfter: string | null = null;
	let onPage = false;
	let pointing: string | null = null;
	let hovered: string | null = null;
	let boundary: Boundary | null = null;
	let boundaryHeld = false;
	let boundaryTimer: number | undefined;
	let removed: { key: number; label: string } | null = null;
	let removedTimer: number | undefined;
	let focusRequest = 0;
	let drawn = 0;
	/** A section added or moved: brought into view once the page shows it. */
	let reveal: string | null = null;

	const emit = () => {
		for (const listener of listeners) listener();
	};
	const controller = () => page?.controller ?? null;
	const state = () => controller()?.state() ?? null;

	// ── words ──

	const errorText = (code: string): string => {
		const errors = said.errors as Record<string, string>;
		return errors[code] ?? fill(said.errors.other, { code });
	};
	/** The controller's words (`pageLayout.*` in the editing bar's): what each action is called. */
	const word = (key: string): string => {
		const name = key.replace(/^pageLayout\./, "");
		return (said.steps as Record<string, string>)[name] ?? name;
	};

	// ── the page's Entry's shared Draft ──

	/**
	 * The page's Entry's shared Draft, as the controller changes it (Props typed in): the shell's one copy
	 * of it (the page editing's `drafts`, over one socket: a second would show the person to themselves
	 * as someone else). Its changes, the person's and others', come to its listeners.
	 */
	function openShared(entryId: string) {
		const item = `entry:${entryId}`;
		const client = (): DraftClient | null => wrapped?.drafts().client(item) ?? null;
		const heard = new Set<(draft: unknown) => void>();
		const stop =
			wrapped?.drafts().onChange((changed, draft) => {
				if (changed !== item) return;
				for (const listener of heard) listener(draft);
			}) ?? (() => {});
		/** The person's last change of the Draft, to tell it was kept once it is saved. */
		let committed: { before: Json; after: Json } | null = null;
		const shared: SharedDraft = {
			stage() {
				const staged = client()?.stage();
				if (!staged) return null;
				return {
					...staged,
					commit() {
						const receipt = staged.commit();
						committed = receipt;
						return receipt;
					},
				};
			},
			ready() {
				const status = client()?.status();
				return status !== undefined && status !== "connecting" && status !== "readOnly" && status !== "ended";
			},
			draft: () => client()?.draft() ?? null,
			change: (next) => client()?.change(next as (current: Json) => Json) ?? false,
			listen(listener) {
				heard.add(listener);
				return () => {
					heard.delete(listener);
				};
			},
			reverse: async (from, to) => (await client()?.reverse(from, to)) ?? { ok: false, code: "HISTORY_UNAVAILABLE" },
			saved() {
				const open = client();
				const receipt = committed;
				committed = null;
				if (!open) return Promise.resolve(false);
				options.saving("saving");
				open.flush();
				const started = Date.now();
				return new Promise<boolean>((resolve) => {
					const check = () => {
						const status = open.status();
						let done: boolean | null = null;
						if (status === "saved") done = kept(open, receipt);
						else if (status === "readOnly" || status === "ended" || Date.now() - started > 8000) done = false;
						if (done === null) {
							window.setTimeout(check, 100);
							return;
						}
						options.saving(done ? "saved" : "failed");
						resolve(done);
					};
					window.setTimeout(check, 50);
				});
			},
		};
		return {
			shared,
			close() {
				heard.clear();
				stop();
			},
		};
	}

	// ── the controller's kit ──

	/** What the controller is given in place of the editing bar's kit: the shell's parts. */
	function kitFor(pageDoc: Document, entryId: string, shared: SharedDraft): BarKit {
		const kit = {
			win: pageDoc.defaultView,
			doc: pageDoc,
			send: (...args: Parameters<typeof fetch>) => fetch(...args),
			later: (work: () => void, delay: number) => window.setTimeout(work, delay),
			cancel: (timer: number | undefined) => window.clearTimeout(timer),
			token: options.token,
			async call(action: string, body: object) {
				const saves = action === "layout/save";
				if (saves) options.saving("saving");
				const answer = await options.request(action, body);
				if (saves) options.saving(answer.ok ? "saved" : "failed");
				return answer.ok ? { ok: true, data: answer.data } : { ok: false, code: answer.code, data: answer.data };
			},
			word,
			announce: (text: string) => announce(text),
			say: (text: string, urgent: boolean) => announce(text, urgent),
			errorText,
			state: () => ({ language: { code: pageState?.language?.code ?? "" } }),
			// The Draft's state is read again after each save (`saving`); the page's sections are drawn below.
			refresh: async () => {},
			editing: () => mode === "edit" && page?.doc === pageDoc,
			phone: () => false,
			freshPage: () => freshPage(pageDoc),
			// The agent makes the regions of what is drawn again editable, as it watches the page.
			adopt: () => {},
			shared: (item: string) => (item === `entry:${entryId}` ? shared : null),
		};
		return kit as unknown as BarKit;
	}

	/**
	 * The page as Edit mode draws it now, for the controller to take its sections from: the frame's own
	 * address read again. What it changes in the page is then measured again.
	 */
	async function freshPage(pageDoc: Document): Promise<Document | null> {
		const view = pageDoc.defaultView;
		if (!view || page?.doc !== pageDoc) return null;
		try {
			const answer = await fetch(`${view.location.pathname}${view.location.search}`, {
				credentials: "same-origin",
				cache: "no-store",
			});
			if (!(answer.headers.get("content-type") ?? "").startsWith("text/html")) return null;
			const fresh = new DOMParser().parseFromString(await answer.text(), "text/html");
			// The controller puts its sections in the page right after this answers.
			window.setTimeout(() => redrawn(pageDoc), 0);
			return fresh;
		} catch {
			return null;
		}
	}

	/** The page's sections were drawn again: their Props named, what was added brought into view. */
	function redrawn(pageDoc: Document) {
		if (page?.doc !== pageDoc) return;
		name(pageDoc);
		hidePreviewed();
		drawn++;
		revealPending();
		emit();
	}

	/** Brings what was added or moved into view, once the page shows it. */
	function revealPending() {
		if (!reveal) return;
		const shown = elementsOf(reveal)[0];
		if (!shown) return;
		shown.scrollIntoView({ block: "nearest", inline: "nearest" });
		reveal = null;
	}

	/** Each text Prop typed in place is named by its Prop's label: its chip says it. */
	function name(pageDoc: Document) {
		const data = state()?.data;
		if (!data) return;
		for (const element of pageDoc.querySelectorAll<HTMLElement>("[data-wc-placement-prop]")) {
			const placement = data.layout.placements.find((each) => each.id === element.dataset.wcPlacement);
			const prop = placement?.props.find((each) => each.key === element.dataset.wcPlacementProp);
			if (prop && element.getAttribute("data-wc-label") !== prop.label)
				element.setAttribute("data-wc-label", prop.label);
		}
	}

	/** Preview shows the page as visitors see it: a hidden section isn't there. */
	function hidePreviewed() {
		doc?.documentElement.toggleAttribute("data-wc-preview", mode === "preview");
	}

	// ── the page in the frame ──

	/** Reads the page's Page layout and starts arranging it, once the page is parsed and Edit mode said what it is. */
	async function start() {
		const item = pageState?.page.item ?? "";
		const layout = (pageState?.page as { layout?: boolean } | undefined)?.layout === true;
		if (!doc || parsed !== doc || !pageState || !layout || !item.startsWith("entry:")) return;
		const entryId = item.slice("entry:".length);
		if (page && page.doc === doc && page.entryId === entryId) return;
		stopPage();
		const pageDoc = doc;
		page = { doc: pageDoc, entryId, controller: null, shared: null, stops: [], loading: true };
		emit();
		const answer = await options.request<LayoutState>("layout/get", { entryId, language: pageState.language.code });
		if (page?.doc !== pageDoc || page.entryId !== entryId) return;
		page.loading = false;
		if (!answer.ok) {
			emit();
			return;
		}
		const opened = openShared(entryId);
		const made = pageLayoutController(kitFor(pageDoc, entryId, opened.shared), answer.data, entryId);
		page.shared = opened;
		page.controller = made;
		page.stops.push(
			made.subscribe(() => {
				name(pageDoc);
				if (selectedGone()) onPage = false;
				emit();
			}),
			made.finished((step) => record(step, entryId)),
			made.flushWith(() => {
				for (const flush of flushers) flush();
			}),
			history.listen({ reveal: (location) => revealStep(location, entryId) }),
		);
		name(pageDoc);
		hidePreviewed();
		emit();
	}

	function stopPage() {
		if (!page) return;
		for (const stop of page.stops.splice(0)) stop();
		page.controller?.dispose();
		page.shared?.close();
		page = null;
		onPage = false;
		hovered = null;
		boundary = null;
		pointing = null;
		view = "list";
		addAfter = null;
		reveal = null;
		clearLanding();
	}

	const selectedGone = () => {
		const now = state();
		return !now?.selected || !now.data.layout.placements.some((each) => each.id === now.selected);
	};

	/** Each finished action is a step of the tab's Undo history: the Page layout as it was and became. */
	function record(step: LayoutStep, entryId: string) {
		const resource = draftResource(options.siteId, `entry:${entryId}`);
		history.record({
			resource,
			before: { layout: documentValue(step.before) },
			after: { layout: documentValue(step.after) },
			label: step.label,
			location: {
				siteId: options.siteId,
				draft: resource,
				panel: step.panel === "inspector" ? "inspector" : "tree",
				selection: step.selection,
				title: options.title(),
			},
		});
	}

	/** A step taken back on this page: its section is chosen again (and the list shows it). */
	function revealStep(location: HistoryLocation, entryId: string): boolean {
		if (location.draft !== draftResource(options.siteId, `entry:${entryId}`)) return false;
		const made = controller();
		if (!made) return false;
		const id = location.selection ?? null;
		if (id && made.state().data.layout.placements.some((each) => each.id === id)) made.select(id);
		return true;
	}

	// ── what the page shows of the sections ──

	function elementsOf(id: string): HTMLElement[] {
		if (!doc) return [];
		return [...doc.querySelectorAll<HTMLElement>(`[data-wc-page-placement="${CSS.escape(id)}"]`)].filter(
			(element) => !element.parentElement?.closest(PLACEMENT),
		);
	}

	/** The section an element of the page is in. */
	const sectionOf = (target: EventTarget | null): string | null => {
		const win = frame?.contentWindow as (Window & typeof globalThis) | null | undefined;
		if (!win || !(target instanceof win.Element)) return null;
		let found = target.closest<HTMLElement>(PLACEMENT);
		while (found?.parentElement?.closest(PLACEMENT)) found = found.parentElement.closest<HTMLElement>(PLACEMENT);
		return found?.dataset.wcPagePlacement ?? null;
	};

	/** What the client editing marks (a region, a photo, a link, a Prop typed in place): it, not its section. */
	const markedOf = (target: EventTarget | null): boolean => {
		const win = frame?.contentWindow as (Window & typeof globalThis) | null | undefined;
		return (
			!!win &&
			target instanceof win.Element &&
			!!target.closest(
				"[data-wc-item][data-wc-field], [data-wc-placement-prop], a[href], button, input, select, textarea, label",
			)
		);
	};

	/** The boundaries between the sections, top to bottom, in the page's own coordinates. */
	function boundaries(): Boundary[] {
		const data = state()?.data;
		if (!data || !doc) return [];
		const view = doc.defaultView;
		const scroll = view?.scrollY ?? 0;
		const shown = data.layout.placements
			.map((placement) => ({ id: placement.id, box: unionOf(elementsOf(placement.id)) }))
			.filter((each): each is { id: string; box: DOMRect } => each.box !== null);
		if (shown.length === 0) return [];
		const list: Boundary[] = [];
		const first = shown[0];
		if (first)
			list.push({ after: HEADER_ROW, next: first.id, y: first.box.top + scroll, from: first.box.top + scroll });
		shown.forEach((each, index) => {
			const next = shown[index + 1];
			const bottom = each.box.bottom + scroll;
			// Two sections may have a gap between them (their margins): the boundary is all of it.
			const top = next ? Math.max(bottom, next.box.top + scroll) : bottom;
			list.push({ after: each.id, next: next?.id ?? null, y: top, from: bottom });
		});
		return list;
	}

	function pointerAt(event: Event) {
		const pointer = event as PointerEvent;
		const view = doc?.defaultView;
		if (!view) return;
		const y = pointer.clientY + view.scrollY;
		const near = boundaries().find((each) => y >= each.from - BOUNDARY_REACH && y <= each.y + BOUNDARY_REACH) ?? null;
		const section = markedOf(event.target) ? null : sectionOf(event.target);
		let changed = false;
		if (near?.after !== boundary?.after || near?.y !== boundary?.y) {
			if (near) {
				window.clearTimeout(boundaryTimer);
				boundary = near;
				changed = true;
			} else if (boundary && !boundaryHeld) leaveBoundary();
		}
		if (section !== hovered) {
			hovered = section;
			changed = true;
		}
		if (changed) emit();
	}

	/** The pointer left the boundary: the line stays a moment, for the pointer to reach its button. */
	function leaveBoundary() {
		window.clearTimeout(boundaryTimer);
		boundaryTimer = window.setTimeout(() => {
			if (boundaryHeld) return;
			boundary = null;
			emit();
		}, 250);
	}

	/** Where a card pointed at in the picker lands: a dashed place in the page, named. */
	function showLanding(componentId: string | null) {
		clearLanding();
		const data = state()?.data;
		const component = data?.components.find((each) => each.id === componentId);
		if (!doc || !data || !component || view !== "add") return;
		const landing = doc.createElement("div");
		landing.setAttribute(LANDING, "");
		landing.setAttribute("aria-hidden", "true");
		landing.textContent = fill(said.landsHere, { name: component.name });
		for (const [property, value] of [
			["display", "flex"],
			["align-items", "center"],
			["justify-content", "center"],
			["box-sizing", "border-box"],
			["height", "96px"],
			["margin", "10px 24px"],
			["border", "2px dashed #4f46e5"],
			["border-radius", "12px"],
			["background", "#4f46e514"],
			["color", "#4f46e5"],
			["font", "600 13px/1.4 ui-sans-serif, system-ui, sans-serif"],
		] as const)
			landing.style.setProperty(property, value);
		const placements = data.layout.placements;
		const after =
			addAfter === HEADER_ROW ? null : placements.find((each) => each.id === addAfter) ? addAfter : undefined;
		if (after) {
			const last = elementsOf(after).at(-1);
			if (last) {
				last.after(landing);
				landing.scrollIntoView({ block: "nearest" });
				return;
			}
		}
		const firstId = placements[0]?.id;
		if (after === null && firstId) {
			const first = elementsOf(firstId)[0];
			if (first) {
				first.before(landing);
				landing.scrollIntoView({ block: "nearest" });
				return;
			}
		}
		// At the end (or a page without sections yet): where the page's content ends.
		const end = layoutComment(doc, after === null ? "wc-page-layout-start" : "wc-page-layout-end");
		if (!end?.parentNode) return;
		if (after === null) end.parentNode.insertBefore(landing, end.nextSibling);
		else end.parentNode.insertBefore(landing, end);
		landing.scrollIntoView({ block: "nearest" });
	}

	function clearLanding() {
		for (const each of doc?.querySelectorAll(`[${LANDING}]`) ?? []) each.remove();
	}

	// ── what the page's events do ──

	const wrap = (editing: Edit): Edit => {
		wrapped = editing;
		return {
			...editing,
			connect(parts) {
				frame = parts.frame;
				const disconnect = editing.connect(parts);
				return () => {
					disconnect();
					frame = null;
				};
			},
			page(document, address, isPage) {
				stopPage();
				doc = document;
				parsed = null;
				pageState = null;
				emit();
				editing.page(document, address, isPage);
			},
			ready(document) {
				editing.ready(document);
				if (document !== doc) return;
				const first = parsed !== document;
				parsed = document;
				if (first) void start();
				else if (page?.doc === document) {
					// Drawn again in place (a change to the page's Structure): its Props named again.
					name(document);
					hidePreviewed();
				}
			},
			pageState(next) {
				pageState = next;
				editing.pageState(next);
				void start();
			},
			event(kind, event) {
				if (mode === "edit" && page?.controller) {
					switch (kind) {
						case "pointermove":
							pointerAt(event);
							break;
						case "pointerleave":
							if (hovered) {
								hovered = null;
								emit();
							}
							if (boundary && !boundaryHeld) leaveBoundary();
							break;
						case "click": {
							// A click on a section's own part (not on what is changed in it) chooses it as a whole.
							const section = sectionOf(event.target);
							const whole = section !== null && !markedOf(event.target);
							if (whole !== onPage || section !== state()?.selected) {
								onPage = whole;
								emit();
							}
							if (whole && section) select(section, { onPage: true });
							break;
						}
						case "keydown": {
							const key = event as KeyboardEvent;
							// Escape in the page puts the section's bar away before it closes the panel.
							if (key.key === "Escape" && onPage && !markedOf(event.target)) {
								onPage = false;
								emit();
								return true;
							}
							break;
						}
						default:
							break;
					}
				}
				return editing.event(kind, event);
			},
			setMode(next) {
				editing.setMode(next);
				if (next === mode) return;
				mode = next;
				// The controller hears Edit and Preview as it does in the editing bar.
				if (page) {
					if (mode === "preview") {
						for (const flush of flushers) flush();
						onPage = false;
						hovered = null;
						boundary = null;
						clearLanding();
					}
					page.doc.dispatchEvent(new CustomEvent("webcraft:edit-mode"));
				}
				hidePreviewed();
				emit();
			},
			destroy() {
				stopPage();
				editing.destroy();
			},
		};
	};

	function select(id: string | null, choose: { onPage?: boolean; focus?: boolean } = {}) {
		const made = controller();
		if (!made) return;
		if (choose.onPage !== undefined) onPage = choose.onPage && id !== null && id !== HEADER_ROW && id !== FOOTER_ROW;
		made.select(id, { focus: choose.focus });
		if (choose.focus) focusRequest++;
		emit();
	}

	const snapshot = (): SectionsSnapshot => {
		const now = state();
		const status = page === null || mode !== "edit" ? "none" : !now ? "loading" : now.editing ? "ready" : "none";
		const data = now?.data;
		const rows: SectionRow[] = [];
		const pageDoc = doc;
		if (data && pageDoc) {
			const outside = (selector: string) =>
				[...pageDoc.querySelectorAll(selector)].some((element) => !element.closest("main, article"));
			if (outside(SITE_HEADER))
				rows.push({
					id: HEADER_ROW,
					kind: "header",
					label: said.header,
					name: said.header,
					locked: true,
					hidden: false,
					sketch: "plain",
				});
			for (const placement of data.placements) {
				const own = data.layout.placements.find((each) => each.id === placement.id);
				rows.push({
					id: placement.id,
					kind: "section",
					label: placement.label,
					name: placement.componentName,
					locked: placement.locked,
					hidden: own?.hidden ?? placement.hidden,
					sketch: kindOf(placement.props),
				});
			}
			if (outside(SITE_FOOTER))
				rows.push({
					id: FOOTER_ROW,
					kind: "footer",
					label: said.footer,
					name: said.footer,
					locked: true,
					hidden: false,
					sketch: "plain",
				});
		}
		return {
			status,
			rows,
			count: data?.layout.placements.length ?? 0,
			selected: now?.selected ?? null,
			onPage: onPage && status === "ready",
			view,
			addAfter,
			components: (data?.components ?? []).map((each) => ({ ...each, kind: kindOf(each.props) })),
			pointing,
			hovered: status === "ready" ? hovered : null,
			boundary: status === "ready" ? boundary : null,
			removed,
			grabbed: now?.grabbed ?? false,
			busy: now?.busy ?? false,
			focusRequest: focusRequest + (now?.focusRequest ?? 0),
			language: data?.language ?? "",
			defaultLanguage: data?.defaultLanguage ?? "",
			relationships: data?.relationships ?? {},
			props: Object.fromEntries((data?.layout.placements ?? []).map((each) => [each.id, each.props])),
			drawn,
		};
	};
	let cached: { key: string; value: SectionsSnapshot } | null = null;

	const refusalText = (refusal: LayoutRefusal): string => (said.refusals as Record<string, string>)[refusal] ?? "";

	/** Says why an action can't be done now, when it can't: true when it was refused. */
	const refused = (action: LayoutAction, id: string | null | undefined): boolean => {
		const made = controller();
		if (!made) return true;
		const why = made.refusal(action, id ?? made.state().selected);
		if (!why || why === "busy") return why === "busy";
		const text = refusalText(why);
		if (text) announce(text, true);
		return true;
	};

	return {
		wrap,
		snapshot() {
			// One object while nothing changed: React reads it on every render.
			const value = snapshot();
			const key = JSON.stringify(value);
			if (cached?.key !== key) cached = { key, value };
			return cached.value;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		onMove: (listener) => wrapped?.onMove(listener) ?? (() => {}),
		boxOf: (element) => wrapped?.boxOf(element) ?? null,
		elementsOf,
		sectionBox(id) {
			const boxes = elementsOf(id)
				.map((element) => wrapped?.boxOf(element) ?? null)
				.filter((box): box is DOMRect => box !== null);
			return unionOfBoxes(boxes);
		},
		frameBox: () => frame?.getBoundingClientRect() ?? null,
		select,
		act(action, id) {
			const made = controller();
			if (!made || refused(action, id)) return;
			dismissRemovedNow();
			const target = id ?? made.state().selected;
			void made.action(action, target).then(() => {
				// What moved, or the copy (the controller chooses it), is brought into view.
				if (action !== "hide") reveal = made.state().selected;
				revealPending();
				emit();
			});
		},
		remove(id) {
			const made = controller();
			if (!made || refused("delete", id)) return;
			const target = id ?? made.state().selected;
			const label = target ? made.label(target) : "";
			const before = made.state().data.layout.placements.length;
			void made.action("delete", target).then(() => {
				if (made.state().data.layout.placements.length >= before) return;
				dismissRemovedNow();
				removed = { key: Date.now(), label };
				announce(fill(said.removedNamed, { name: label }));
				emit();
			});
		},
		undoRemove() {
			if (!removed) return;
			dismissRemovedNow();
			emit();
			options.undo();
		},
		dismissRemoved() {
			dismissRemovedNow();
			emit();
		},
		refusal(action, id) {
			const made = controller();
			return made ? made.refusal(action, id ?? made.state().selected) : "unavailable";
		},
		grab(change) {
			const made = controller();
			if (!made) return;
			if (change === "pick" && refused("moveUp", null) && refused("moveDown", null)) return;
			void made.grab(change).then(() => {
				if (change === "pick" && made.state().grabbed) {
					const selected = made.state().selected;
					announce(fill(said.picked, { name: selected ? made.label(selected) : "" }));
				}
				if (change === "cancel") announce(said.putBack);
				emit();
			});
			emit();
		},
		drop(from, to) {
			const made = controller();
			if (!made) return;
			reveal = made.state().data.layout.placements[from]?.id ?? null;
			void made.drop(from, to).then(() => {
				revealPending();
				emit();
			});
		},
		view(next, choose = {}) {
			const made = controller();
			if (!made) return;
			for (const flush of flushers) flush();
			if (made.state().grabbed) void made.grab("drop");
			if (next === "add") addAfter = choose.after !== undefined ? choose.after : (made.insertsAfter() ?? null);
			else clearLanding();
			view = next;
			pointing = null;
			if (choose.focus !== false) focusRequest++;
			emit();
		},
		add(componentId) {
			const made = controller();
			if (!made) return;
			if (refusalOfAdd()) return;
			dismissRemovedNow();
			clearLanding();
			pointing = null;
			const before = new Set(made.state().data.layout.placements.map((each) => each.id));
			made.select(addAfter === null ? FOOTER_ROW : addAfter);
			void made.insert(componentId).then(() => {
				const added = made.state().data.layout.placements.find((each) => !before.has(each.id));
				if (!added) return;
				view = "list";
				addAfter = null;
				onPage = true;
				reveal = added.id;
				revealPending();
				focusRequest++;
				emit();
			});
		},
		point(componentId) {
			if (pointing === componentId) return;
			pointing = componentId;
			showLanding(componentId);
			emit();
		},
		holdBoundary(held) {
			boundaryHeld = held;
			if (held) window.clearTimeout(boundaryTimer);
			else if (boundary) leaveBoundary();
		},
		values: (id) => (controller()?.values(id) as Record<string, unknown> | undefined) ?? {},
		prop(id, field, value, finish) {
			controller()?.prop(id, field, value as never, !finish);
		},
		finishProps(id) {
			void controller()?.flushProps(id);
		},
		finishWith(flush) {
			flushers.add(flush);
			return () => {
				flushers.delete(flush);
			};
		},
		async media(id) {
			const answer = await options.request<{ media: MediaItem }>("layout/mediaGet", { mediaId: id });
			return answer.ok ? answer.data.media : null;
		},
		closed() {
			for (const flush of flushers) flush();
			const made = controller();
			if (made?.state().grabbed) void made.grab("drop");
			clearLanding();
			pointing = null;
			view = "list";
			emit();
		},
		destroy() {
			stopPage();
			window.clearTimeout(boundaryTimer);
			window.clearTimeout(removedTimer);
			listeners.clear();
		},
	};

	/** Adding is refused while arranging isn't open to the person, or while a save is under way. */
	function refusalOfAdd(): boolean {
		const now = state();
		return !now?.editing || now.busy;
	}

	function dismissRemovedNow() {
		window.clearTimeout(removedTimer);
		removed = null;
	}
}

/**
 * Whether the Draft still holds the person's change where it made it, once saved: a refused change is
 * taken out of the copy again (the server's document comes back).
 */
function kept(client: DraftClient, receipt: { before: Json; after: Json } | null): boolean {
	if (!receipt) return true;
	try {
		reverseChange(receipt.after, receipt.before, client.draft());
		return true;
	} catch {
		return false;
	}
}

/** The box around a section's elements, as the frame's page has them (null: none is shown). */
export function unionOf(elements: readonly Element[]): DOMRect | null {
	return unionOfBoxes(elements.map((element) => element.getBoundingClientRect()));
}

/** The box around boxes (those with no size left out), or null. */
export function unionOfBoxes(boxes: readonly DOMRect[]): DOMRect | null {
	let box: { left: number; top: number; right: number; bottom: number } | null = null;
	for (const each of boxes) {
		if (each.width === 0 && each.height === 0) continue;
		box = box
			? {
					left: Math.min(box.left, each.left),
					top: Math.min(box.top, each.top),
					right: Math.max(box.right, each.right),
					bottom: Math.max(box.bottom, each.bottom),
				}
			: { left: each.left, top: each.top, right: each.right, bottom: each.bottom };
	}
	return box ? new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top) : null;
}

/** The comment the page's sections start or end at (`wc-page-layout-start`, `wc-page-layout-end`). */
function layoutComment(doc: Document, value: string): Comment | null {
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
	for (let node = walker.nextNode(); node; node = walker.nextNode())
		if (node.nodeValue === value) return node as Comment;
	return null;
}

/**
 * A Page layout read from JSON as a Draft's document types it: what JSON holds and nothing else, a key
 * without a value left out as JSON leaves it out.
 */
function documentValue(value: unknown): Json {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return value;
	if (Array.isArray(value)) return value.map(documentValue);
	if (typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).flatMap(([key, each]) =>
				each === undefined ? [] : [[key, documentValue(each)]],
			),
		);
	return null;
}
