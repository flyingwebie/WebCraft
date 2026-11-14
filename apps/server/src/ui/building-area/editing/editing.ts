import type { Json } from "@webcraft/core/draft-document";

import type { HistoryLocation } from "../../builder/editor-history.ts";
import { TEXT_REGION } from "../agent/contract.ts";
import { fill, type PageState, type Words } from "../api.ts";
import { nameOf, type Overlay, type OverlayMark } from "../canvas/overlay.ts";
import type { RegionSaving, SavedAnswer, SaveWatch } from "../canvas/regions.ts";
import { PUBLISH_OPEN_EVENT } from "../publish/sources.ts";
import { type PageDrafts, pageDrafts } from "./drafts.ts";
import type { ShellHistory } from "./history.ts";
import { displayName, peopleIn, presenceMarks, regionPlace } from "./presence.ts";

/**
 * Content typed in place, the shell's side (ADR 0037 › 1.3 and 1.5, BA-07). The page agent makes the
 * regions editable and the caret lives in the page; `regionSaving` (`canvas/regions.ts`) saves what is
 * typed. This adds what editing a page's text needs around that, for everyone who edits:
 * - the text toolbar of a region that takes formatting (`TextToolbar.tsx`): Bold, Italic, Link, lists,
 *   Undo and Done, reached from the text with Alt+F10, Escape back to it;
 * - a region's problems (what keeps its value from being published) beside it, and said;
 * - the Undo history's steps (`history.ts`): each finished burst of typing, and Undo / Redo from the
 *   keys in the page and the browser's own Undo of text;
 * - the page's shared Drafts (`drafts.ts`): others' changes shown as they arrive, Presence (their
 *   colour and name on the region they are in) and the amber dot on each value changed and not
 *   published (from the page's `state`).
 *
 * The canvas's frame calls it (`Frame`'s `editing`); React draws its toolbar from `snapshot()`.
 * Later editing (BA-08 onwards) adds to the same seams: `history` for its steps, `drafts` for the
 * Drafts it opens.
 */
export type PageEditing = {
	/** The frame is there: its element, its overlay and how its regions save. Answers how to stop. */
	connect(parts: { frame: HTMLIFrameElement; overlay: Overlay; saving: RegionSaving }): () => void;
	/** A page started in the frame (a stand-in is no page of the Site: nothing of it is edited here). */
	page(document: Document, address: string, isPage: boolean): void;
	/** The page is parsed: its regions are there. */
	ready(document: Document): void;
	/** What Edit mode says of the page now (`state`): its changes, title and language. */
	pageState(state: PageState): void;
	/**
	 * One of the page's events, as the agent hands it over (`AgentHost.event`). True when it was taken
	 * here (the agent then stops it): Undo and Redo, Alt+F10.
	 */
	event(kind: string, event: Event): boolean;
	/** Follows a region's save (`regionSaving`'s `watch`): its Undo step, its problems, the value as stored. */
	watch(region: Element): SaveWatch;
	/** What the toolbar and the problem note draw now. */
	snapshot(): EditingSnapshot;
	/** Called when the snapshot changes. Answers how to stop listening. */
	subscribe(listener: () => void): () => void;
	/** The toolbar's tools. */
	tools: TextTools;
	/** Where an element of the page is on the shell's window, and a listener for when it moves. */
	boxOf(element: Element): DOMRect | null;
	onMove(listener: () => void): () => void;
	/** Stops for good: closes the page's Drafts. */
	destroy(): void;
};

/** What the shell draws for the region being edited. */
export type EditingSnapshot = {
	/** The region being edited, its name (its Field's label), and whether it takes formatting. */
	region: { element: HTMLElement; name: string; rich: boolean } | null;
	/** Whether the text toolbar shows (a rich text region, not dismissed with Done). */
	toolbar: boolean;
	/** Bumped each time focus should go into the toolbar (Alt+F10). */
	reach: number;
	/** Which formatting is on where the caret is. */
	pressed: { bold: boolean; italic: boolean };
	/** The region's problem, worded, when it has one. */
	problem: string | null;
};

/** The text toolbar's tools, acting on the text being edited. */
export type TextTools = {
	/** Runs an editing command (`bold`, `italic`, `insertUnorderedList`, …) on the text, its selection put back first. */
	exec(command: string, value?: string): void;
	/** The link where the caret is, if any: its address. */
	linkHere(): string;
	/** Puts focus back in the text, where the caret was. */
	backToText(): void;
	/** Done: saves the text and puts the toolbar away; from the keyboard focus goes back to the text, else editing ends. */
	done(fromKeyboard: boolean): void;
	/** Focus left the toolbar for `next` (null: the window). Ends editing unless it went back to the text. */
	left(next: Element | null): void;
	/** The history's Undo, then back to the text. */
	undo(): void;
};

/** The rich text a region may hold (the server keeps the same when it cleans a save). */
const KEPT_TAGS = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "S", "CODE", "SUB", "SUP", "A", "UL", "OL", "LI"]);

/**
 * Rich text from elsewhere (someone else's, a step taken back), before it shows in the page: only
 * formatting, lists and links to addresses a page may link to are kept, made in the page's document.
 */
export function cleanHtml(html: string, into: Document): Node[] {
	const parsed = new DOMParser().parseFromString(html, "text/html");
	const copy = (node: Node): Node[] => {
		if (node.nodeType === Node.TEXT_NODE) return [into.createTextNode(node.textContent ?? "")];
		if (node.nodeType !== Node.ELEMENT_NODE) return [];
		const children = [...node.childNodes].flatMap(copy);
		const element = node as Element;
		if (!KEPT_TAGS.has(element.tagName)) return children;
		const made = into.createElement(element.tagName.toLowerCase());
		const href = element.getAttribute("href");
		if (element.tagName === "A" && href && /^(https?:|mailto:|tel:|\/|#)/i.test(href.trim())) {
			made.setAttribute("href", href.trim());
		}
		made.append(...children);
		return [made];
	};
	return [...parsed.body.childNodes].flatMap(copy);
}

/**
 * A region's value in the page's language (else the Default language's), from a Draft as its shared
 * document holds it: `values.<key>[.values.<key>…].<language>`.
 */
export function valueAt(draft: unknown, field: string, language: string | null, fallback: string | null): unknown {
	const record = (value: unknown) =>
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	let node: unknown = record(draft).values;
	const parts = field.split(".");
	parts.forEach((part, index) => {
		node = record(node)[part];
		if (index < parts.length - 1) node = record(node).values;
	});
	const kept = record(node);
	return kept[language ?? ""] ?? kept[fallback ?? ""];
}

/** How long after the last change from elsewhere the page's `state` is read again, in milliseconds. */
const REFRESH_DELAY_MS = 500;

export function pageEditing(options: {
	token: string;
	siteId: string;
	words: Words;
	history: ShellHistory;
	announce(text: string, urgent?: boolean): void;
	/** Reads the page's `state` again (its changes, its Reviews): the Draft changed. */
	refresh(): void;
	/** A change of the person's didn't save (a shared Draft refused it): the Draft state says so. */
	failed(): void;
}): PageEditing {
	const { words, history, announce } = options;
	const said = words.editing;
	const listeners = new Set<() => void>();
	/** What follows the page on the shell's window (the toolbar): told after each drawing of the overlay. */
	const moves = new Set<() => void>();
	let snapshot: EditingSnapshot = {
		region: null,
		toolbar: false,
		reach: 0,
		pressed: { bold: false, italic: false },
		problem: null,
	};
	const set = (next: Partial<EditingSnapshot>) => {
		snapshot = { ...snapshot, ...next };
		for (const listener of listeners) listener();
	};

	let parts: { frame: HTMLIFrameElement; overlay: Overlay; saving: RegionSaving } | null = null;
	let doc: Document | null = null;
	let state: PageState | null = null;
	let current: HTMLElement | null = null;
	/** Done put the toolbar away: it comes back with the next keystroke or the next region. */
	let dismissed = false;
	/** The text's selection, kept for the toolbar's tools to act on once focus is in the toolbar. */
	let selection: Range | null = null;
	const problems = new WeakMap<Element, string>();
	let refreshTimer: number | undefined;
	/** The people seen in the page's Drafts, so each arrival is said once. */
	let seen = new Set<string>();

	const regions = (): HTMLElement[] => (doc ? [...doc.querySelectorAll<HTMLElement>(TEXT_REGION)] : []);

	const refreshSoon = () => {
		window.clearTimeout(refreshTimer);
		refreshTimer = window.setTimeout(() => options.refresh(), REFRESH_DELAY_MS);
	};

	/** The marks on the page: someone else in a region, and each value changed and not published. */
	const drawMarks = () => {
		if (!parts) return;
		const shown = regions();
		const changed = new Set((state?.changes ?? []).map((change) => `${change.item}|${change.key}`));
		const dots: OverlayMark[] = shown.flatMap((region) => {
			const place = regionPlace(region);
			return place && changed.has(`${place.item}|${place.at}`)
				? [{ kind: "changed" as const, element: region, label: said.changedHere }]
				: [];
		});
		parts.overlay.marks([...dots, ...presenceMarks(drafts.others(), shown, words)]);
	};

	/**
	 * A change to one of the page's Drafts that wasn't typed here: someone else's, which regions nobody
	 * is typing in show, or one of the person's steps taken back, which the region being edited shows
	 * too, its caret going to the end. What was typed and not saved yet stays either way: it is the
	 * person's next step.
	 */
	const showChange = (item: string, draft: Json, own: boolean) => {
		const saving = parts?.saving;
		if (!saving || !doc) return;
		for (const region of regions()) {
			if (region.getAttribute("data-wc-item") !== item || saving.unsaved(region)) continue;
			if (!own && region === current) continue;
			const kept = valueAt(
				draft,
				region.getAttribute("data-wc-field") ?? "",
				state?.language.code ?? null,
				state?.defaultLanguage ?? null,
			);
			// A value a step took away altogether shows as empty; someone else's shows once it holds text.
			const value = typeof kept === "string" ? kept : own ? "" : null;
			if (value === null || value === saving.valueOf(region)) continue;
			if (region.getAttribute("data-wc-type") === "richText") region.replaceChildren(...cleanHtml(value, doc));
			else region.textContent = value;
			saving.remember(region);
			if (region !== current) continue;
			const end = doc.createRange();
			end.selectNodeContents(region);
			end.collapse(false);
			const chosen = doc.getSelection();
			chosen?.removeAllRanges();
			chosen?.addRange(end);
		}
		refreshSoon();
	};

	const drafts: PageDrafts = pageDrafts({
		token: options.token,
		siteId: options.siteId,
		register: (resource, port) => history.register(resource, port),
		onRemote: showChange,
		onRefused(code) {
			options.failed();
			announce(fill(said.refused, { reason: code }), true);
		},
		onPublished: () => refreshSoon(),
	});
	drafts.subscribe(() => {
		drawMarks();
		// Someone new in the page's Drafts is said once, while they stay.
		const people = peopleIn(drafts.others());
		for (const [key, participant] of people) {
			if (!seen.has(key)) announce(fill(said.joined, { name: displayName(participant, words) }));
		}
		seen = new Set(people.keys());
	});

	const problemOf = (region: Element | null) => (region ? (problems.get(region) ?? null) : null);

	const pressedNow = () => {
		const read = (name: string) => {
			try {
				return doc?.queryCommandState(name) ?? false;
			} catch {
				return false;
			}
		};
		return { bold: read("bold"), italic: read("italic") };
	};

	const rememberSelection = () => {
		const chosen = doc?.getSelection();
		const range = chosen?.rangeCount ? chosen.getRangeAt(0) : undefined;
		if (range && current?.contains(range.commonAncestorContainer)) selection = range.cloneRange();
	};

	const startEditing = (region: HTMLElement) => {
		if (current !== region) dismissed = false;
		current = region;
		const rich = region.getAttribute("data-wc-type") === "richText";
		const place = regionPlace(region);
		drafts.place(place?.item ?? null, place?.at ?? null);
		const toolbar = rich && !dismissed;
		parts?.overlay.showChip(!toolbar);
		set({
			region: { element: region, name: parts ? nameOf(region, words) : "", rich },
			toolbar,
			pressed: pressedNow(),
			problem: problemOf(region),
		});
	};

	const stopEditing = () => {
		if (!current) return;
		current = null;
		selection = null;
		drafts.place(null, null);
		parts?.overlay.showChip(true);
		set({ region: null, toolbar: false, problem: null });
	};

	/** Whether focus is in the shell's toolbar now. */
	const inToolbar = () => Boolean(document.activeElement?.closest("[data-wc-text-toolbar]"));

	const backToText = () => {
		const region = current;
		const frame = parts?.frame;
		if (!region || !frame) return;
		frame.focus();
		frame.contentWindow?.focus();
		region.focus();
		const range = selection;
		const chosen = doc?.getSelection();
		if (range && chosen && region.contains(range.commonAncestorContainer)) {
			chosen.removeAllRanges();
			chosen.addRange(range);
		}
	};

	const tools: TextTools = {
		exec(command, value) {
			if (!current || !doc) return;
			backToText();
			doc.execCommand(command, false, value);
			set({ pressed: pressedNow() });
		},
		linkHere() {
			const anchor = selection?.startContainer ?? doc?.getSelection()?.anchorNode ?? null;
			const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
			return element?.closest("a")?.getAttribute("href") ?? "";
		},
		backToText,
		done(fromKeyboard) {
			const region = current;
			if (!region) return;
			void parts?.saving.left(region);
			dismissed = true;
			parts?.overlay.showChip(true);
			set({ toolbar: false });
			// From the keyboard, focus goes back to the text; with a pointer, editing ends there.
			if (fromKeyboard) backToText();
			else {
				region.blur();
				stopEditing();
			}
		},
		left(next) {
			if (!current) return;
			if (next?.closest("[data-wc-text-toolbar]")) return;
			if (next instanceof HTMLIFrameElement && next === parts?.frame) return;
			const region = current;
			void parts?.saving.left(region);
			stopEditing();
		},
		undo() {
			backToText();
			void history.undo();
		},
	};

	/** The region a page event is on, if it is one of the page's text regions. */
	const regionOf = (target: EventTarget | null): HTMLElement | null => {
		const view = parts?.frame.contentWindow as (Window & typeof globalThis) | null | undefined;
		if (!view || !(target instanceof view.Element)) return null;
		return target.closest<HTMLElement>(TEXT_REGION);
	};

	return {
		connect(next) {
			parts = next;
			history.setPage({
				settle: () => next.saving.flush(),
				reveal(location: HistoryLocation) {
					const prefix = `draft:${options.siteId}:`;
					const item = location.draft?.startsWith(prefix) ? location.draft.slice(prefix.length) : null;
					if (!item || location.ref === undefined || !doc) return false;
					const region = regions().find(
						(each) => each.getAttribute("data-wc-item") === item && each.getAttribute("data-wc-field") === location.ref,
					);
					if (!region) return false;
					// The step's region comes into view; focus stays where the person left it.
					region.scrollIntoView({ block: "nearest", inline: "nearest" });
					return true;
				},
			});
			const stopMoves = next.overlay.onDraw(() => {
				for (const listener of moves) listener();
			});
			return () => {
				stopMoves();
				history.setPage(null);
				parts = null;
			};
		},
		page(document, _address, isPage) {
			stopEditing();
			doc = document;
			state = null;
			// Nothing of a stand-in is the Site's Content: no Draft of it opens.
			if (!isPage) drafts.show([]);
			parts?.overlay.marks([]);
		},
		ready(document) {
			if (document !== doc) return;
			const items = regions().map((region) => region.getAttribute("data-wc-item") ?? "");
			drafts.show([...items, ...(state?.page.item ? [state.page.item] : [])]);
			drawMarks();
		},
		pageState(next) {
			state = next;
			if (doc) {
				const items = regions().map((region) => region.getAttribute("data-wc-item") ?? "");
				drafts.show([...items, ...(next.page.item ? [next.page.item] : [])]);
			}
			drawMarks();
		},
		event(kind, event) {
			switch (kind) {
				case "focusin": {
					const region = regionOf(event.target);
					if (region) startEditing(region);
					return false;
				}
				case "focusout": {
					const region = regionOf(event.target);
					if (!region || region !== current) return false;
					// Once focus has moved: into the toolbar it keeps editing open.
					window.setTimeout(() => {
						if (current !== region) return;
						if (doc?.activeElement === region && doc.hasFocus()) return;
						if (inToolbar()) return;
						stopEditing();
					}, 0);
					return false;
				}
				case "input": {
					const region = regionOf(event.target);
					if (!region) return false;
					if (region !== current) startEditing(region);
					if (dismissed && snapshot.region?.rich) {
						dismissed = false;
						parts?.overlay.showChip(false);
						set({ toolbar: true });
					}
					return false;
				}
				case "selectionchange": {
					rememberSelection();
					if (snapshot.region?.rich) {
						const pressed = pressedNow();
						if (pressed.bold !== snapshot.pressed.bold || pressed.italic !== snapshot.pressed.italic) set({ pressed });
					}
					return false;
				}
				case "beforeinput":
					return history.beforeInput(event as InputEvent);
				case "keydown": {
					const key = event as KeyboardEvent;
					if (history.key(key)) return true;
					// ⌘↵ in the page opens the bar's Publish, as in the shell (BA-12).
					if (key.key === "Enter" && (key.metaKey || key.ctrlKey) && !key.altKey && !key.shiftKey) {
						document.dispatchEvent(new CustomEvent(PUBLISH_OPEN_EVENT));
						return true;
					}
					const region = regionOf(event.target);
					if (key.key === "F10" && key.altKey && region && region.getAttribute("data-wc-type") === "richText") {
						// The selection as it is now: a "selectionchange" for it may not have come yet.
						if (region !== current) startEditing(region);
						rememberSelection();
						dismissed = false;
						parts?.overlay.showChip(false);
						set({ toolbar: true, reach: snapshot.reach + 1 });
						return true;
					}
					return false;
				}
				default:
					return false;
			}
		},
		watch(region) {
			const field = region.getAttribute("data-wc-field") ?? "";
			const step = history.watch({
				label: nameOf(region, words),
				field,
				title: state?.page.title || state?.page.path || "",
			});
			return {
				saved(answer: SavedAnswer) {
					step.saved(answer);
					const found = answer.problems[0];
					if (found) {
						const text = (said.problems as Record<string, string>)[found.rule ?? "other"] ?? said.problems.other;
						problems.set(region, text);
						announce(text);
					} else problems.delete(region);
					region.toggleAttribute("data-wc-invalid", Boolean(found));
					if (current === region) set({ problem: problemOf(region) });
					// Rich text comes back cleaned; once the person has moved on, the region shows it as stored.
					const saving = parts?.saving;
					if (saving && doc && typeof answer.value === "string" && current !== region && !saving.unsaved(region)) {
						if (answer.value !== saving.valueOf(region)) {
							if (region.getAttribute("data-wc-type") === "richText")
								region.replaceChildren(...cleanHtml(answer.value, doc));
							else region.textContent = answer.value;
							saving.remember(region);
						}
					}
				},
				settle: step.settle,
			};
		},
		snapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		tools,
		boxOf: (element) => parts?.overlay.boxOf(element) ?? null,
		onMove(listener) {
			moves.add(listener);
			return () => {
				moves.delete(listener);
			};
		},
		destroy() {
			window.clearTimeout(refreshTimer);
			drafts.destroy();
			listeners.clear();
			moves.clear();
		},
	};
}
