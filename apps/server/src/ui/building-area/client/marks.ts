import { LINK_REGION, PHOTO_REGION, TEXT_REGION } from "../agent/contract.ts";
import { fill, type PageState, type Words } from "../api.ts";
import { nameOf, type Overlay, type OverlayMark } from "../canvas/overlay.ts";
import type { RegionSaving } from "../canvas/regions.ts";
import type { PageEditing } from "../editing/editing.ts";
import type { RegionPopovers } from "./popovers.ts";
import { PLACEMENT_PROP } from "./sections.ts";

/**
 * Client editing's marks and keys (SPEC 13.2, 13.3 and 13.9; BA-14): what "easy to see" means on the
 * page. It wraps the page editing everyone has (`editing/editing.ts`, BA-07) and adds, for a Member:
 * - the marks, drawn in the shell's own document over the frame: every area they may change carries a
 *   dashed outline at rest; under the pointer a solid outline, a soft fill and a chip with the Field's
 *   name and "Click to edit"; the area being edited a solid outline (its chip, unless a toolbar names
 *   it); a value changed and not published the amber dot on the outline's corner; something locked a
 *   grey outline and a lock chip that says why, under the pointer only. Someone else's colour and name
 *   on the area they are in stay BA-07's. Preview draws no mark at all;
 * - the keys: Tab and Shift+Tab move between the marked areas (focus on one is not editing yet: it says
 *   "Press Enter to edit", and typing waits); Enter starts editing; Escape finishes, then closes the
 *   side panel. Plain text also finishes with Enter, as a click outside does;
 * - Preview: the page as visitors see it, nothing in it editable.
 *
 * The Staff's outlines and chip (`canvas/overlay.ts`) are switched off; everything else of the frame
 * (saving, the toolbar, the history, Presence) is the page editing it wraps, unchanged.
 *
 * Photos and links (BA-15) are marked too: a click, or Enter (Space on a photo) once one has focus,
 * opens its popover (`popovers.ts`) instead of typing, which names it, so its outline has no chip; a
 * file dragged over a photo outlines it to drop on.
 */
export type ClientEditing = PageEditing & {
	/** Edit (the marks, typing) or Preview (no mark, nothing editable; links are followed). */
	setMode(mode: ClientMode): void;
};

export type ClientMode = "edit" | "preview";

/**
/**
 * A Loop's own item's regions (`loop:<loop id>:<item id>`): a set of values, so a Member changes them
 * in the item's side panel (BA-16, `loop-items.ts`), not one by one in place.
 */
export const IN_ITEM = '[data-wc-item^="loop:"]';
const OWN = `:not(${IN_ITEM})`;

/** The photos and links a Member changes in a popover (BA-15), outside Loop items. */
const POPPED = `${PHOTO_REGION}${OWN}, ${LINK_REGION}${OWN}`;

/**
 * What a Member may change on the page in place: its text regions, photos and links, and the text
 * Props of the page's sections typed in place (BA-17). Loop items are marked and changed as items
 * (`loop-items.ts`).
 */
export const MARKED = `${TEXT_REGION}${OWN}, ${POPPED}, ${PLACEMENT_PROP}`;

/** The parts of a page that are the same on every page (the Site template's), which a Member can't change. */
const LOCKED = "header, footer, [role='banner'], [role='contentinfo']";

/** How far the outline sits off its content, in pixels of the shell (SPEC 13.2: 6 to 8). */
const OFFSET = 6;
/** The chip's height and its gap above the outline (`client-flows/05`). */
const CHIP_HEIGHT = 26;
const CHIP_GAP = 6;
/** The amber dot (SPEC 13.2). */
const DOT_SIZE = 12;

/** The colours of the marks (`client-flows/05`): indigo for what may change, grey for what is locked. */
const MARK = "#4f46e5";
const MARK_SOFT = "#4f46e599";
const MARK_TINT = "#4f46e514";
const LOCK_OUTLINE = "#71717a";
const LOCK_CHIP = "#3f3f46";
const CHANGED = "#f59e0b";

/** Input that changes a region's text: what waits while an area has focus but isn't being edited. */
const KEPT_INPUT = new Set(["historyUndo", "historyRedo"]);

export function clientEditing(options: {
	/** The page editing it wraps (BA-07). */
	inner: PageEditing;
	words: Words;
	announce(text: string, urgent?: boolean): void;
	/** Escape with nothing left to finish: closes the side panel. Answers whether one was open. */
	closePanel(): boolean;
	/** The photo and link popovers (BA-15). */
	popovers: RegionPopovers;
}): ClientEditing {
	const { inner, words, announce, popovers } = options;
	const said = words.client.marks;

	let parts: { frame: HTMLIFrameElement; overlay: Overlay; saving: RegionSaving } | null = null;
	let doc: Document | null = null;
	let mode: ClientMode = "edit";
	/** The area under the pointer: one that may change, or a locked part. */
	let hovered: Element | null = null;
	/** The area that has focus but isn't being edited yet (reached with Tab, or finished with Escape). */
	let armed: HTMLElement | null = null;
	/** The page's focus is moving into `armed` by the keyboard: its focus isn't editing. */
	let arming = false;
	/** A pointer was pressed in the page: the focus that follows is editing. */
	let pointing = false;
	/** The amber dots the page editing asked for (BA-07), drawn on the outlines' corners here. */
	let changed: Element[] = [];
	/** The people marks the page editing asked for, kept to draw again after Preview. */
	let people: OverlayMark[] = [];
	/** What contenteditable each region had before Preview took it away. */
	const editable = new WeakMap<Element, string>();
	/** The page's changes not published, by item and key (the photos' and links' amber dots). */
	let changes = new Set<string>();
	/** The photos and links given what Edit needs of them (a way to reach them, their name), and what they had. */
	const prepared = new Map<HTMLElement, Map<string, string | null>>();

	let layer: HTMLDivElement | null = null;
	const stops: (() => void)[] = [];

	const view = () => parts?.frame.contentWindow as (Window & typeof globalThis) | null | undefined;
	const marked = (): HTMLElement[] =>
		doc ? [...doc.querySelectorAll<HTMLElement>(MARKED)].filter((each) => each.getClientRects().length > 0) : [];
	const regionOf = (target: EventTarget | null): HTMLElement | null => {
		const win = view();
		return win && target instanceof win.Element ? target.closest<HTMLElement>(MARKED) : null;
	};
	const lockedOf = (target: EventTarget | null): Element | null => {
		const win = view();
		if (!win || !(target instanceof win.Element)) return null;
		const part = target.closest(LOCKED);
		// An Entry's own header or footer (inside the content) is the page's, not the Site's.
		return part && !part.closest("main, article") ? part : null;
	};
	const editingNow = (): HTMLElement | null => inner.snapshot().region?.element ?? null;
	/** The photo or link whose popover is open now. */
	const poppedNow = (): HTMLElement | null => popovers.snapshot().open?.element ?? null;
	/** A region's name for people: its Field's label (a photo's or a link's too). */
	const labelOf = (region: Element) =>
		(!region.matches(TEXT_REGION) && region.getAttribute("data-wc-label")) || nameOf(region, words);
	const redraw = () => parts?.overlay.schedule();

	/** Starts editing an area: the page editing takes it as if focus had just come (its toolbar, its Draft). */
	const startEditing = (region: HTMLElement, caretAtEnd: boolean) => {
		armed = null;
		inner.event("focusin", { target: region } as unknown as Event);
		if (caretAtEnd && doc) {
			const range = doc.createRange();
			range.selectNodeContents(region);
			range.collapse(false);
			const selection = doc.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
		redraw();
	};

	/** Focus on an area that isn't being edited: no caret shows, and typing waits for Enter. */
	const arm = (region: HTMLElement, tell: boolean) => {
		armed = region;
		doc?.getSelection()?.removeAllRanges();
		if (tell) announce(fill(said.armed, { name: labelOf(region) }));
		redraw();
	};

	/** Finishes editing an area: saved now, the toolbar put away; focus stays on it. */
	const finish = (region: HTMLElement) => {
		// The page editing saves it and puts its toolbar away, as when focus leaves it; said once it is saved.
		inner.tools.left(null);
		arm(region, false);
		const done = () => announce(fill(said.finished, { name: nameOf(region, words) }));
		void parts?.saving.left(region).then(done, done);
	};

	/** Moves focus to another area with the keyboard: it has focus, not editing. */
	const moveTo = (region: HTMLElement) => {
		arming = true;
		region.focus({ preventScroll: true });
		arming = false;
		region.scrollIntoView({ block: "nearest", inline: "nearest" });
		arm(region, true);
	};

	/** The next marked area after (or before) where focus is in the page, in the page's order. */
	const nextFrom = (from: Element, back: boolean): HTMLElement | null => {
		const all = marked();
		const at = all.indexOf(from as HTMLElement);
		if (at >= 0) return all[at + (back ? -1 : 1)] ?? null;
		const following = (each: Element) => Boolean(from.compareDocumentPosition(each) & Node.DOCUMENT_POSITION_FOLLOWING);
		const isPageStart = from === doc?.body || from === doc?.documentElement;
		if (back) return [...all].reverse().find((each) => isPageStart || !following(each)) ?? null;
		return all.find((each) => isPageStart || following(each)) ?? null;
	};

	/**
	 * Photos and links in Edit: each can be reached with Tab and says what it opens (a photo is a button
	 * there, unless it sits in a link or a button), and an empty one shows its words to be found. Preview
	 * gives each back what it had.
	 */
	const preparePopped = () => {
		if (!doc) return;
		const set = (element: HTMLElement, name: string, value: string) => {
			let kept = prepared.get(element);
			if (!kept) {
				kept = new Map();
				prepared.set(element, kept);
			}
			if (!kept.has(name)) kept.set(name, element.getAttribute(name));
			if (element.getAttribute(name) !== value) element.setAttribute(name, value);
		};
		if (mode === "preview") {
			for (const [element, kept] of prepared) {
				for (const [name, value] of kept) {
					if (value === null) element.removeAttribute(name);
					else element.setAttribute(name, value);
				}
			}
			prepared.clear();
			return;
		}
		for (const [element] of prepared) if (!element.isConnected) prepared.delete(element);
		for (const region of doc.querySelectorAll<HTMLElement>(POPPED)) {
			const name = labelOf(region);
			set(region, "aria-haspopup", "dialog");
			if (region.matches(LINK_REGION)) {
				set(region, "data-wc-empty-label", words.client.link.empty);
				continue;
			}
			set(region, "data-wc-empty-label", words.client.photo.empty);
			set(region, "tabindex", "0");
			set(region, "aria-label", fill(words.client.photo.region, { name }));
			if (!region.parentElement?.closest("a, button, [role='button']")) set(region, "role", "button");
		}
	};

	/** Preview takes editing away from the page's regions; Edit gives it back as it was. */
	const applyMode = () => {
		if (!doc) return;
		preparePopped();
		for (const region of doc.querySelectorAll(TEXT_REGION)) {
			const now = region.getAttribute("contenteditable");
			if (mode === "preview") {
				if (now === "false") continue;
				if (now !== null) editable.set(region, now);
				region.setAttribute("contenteditable", "false");
			} else if (now === "false" && !region.matches(IN_ITEM)) {
				region.setAttribute("contenteditable", editable.get(region) ?? "true");
			}
		}
	};

	// ── drawing ──

	/**
	 * What the layer holds, by a key that stays from one drawing to the next: the same marks are the
	 * same elements, moved and changed in place, never made again (they are drawn every frame the page
	 * moves).
	 */
	const pool = new Map<string, HTMLElement>();
	let used = new Set<string>();
	/** The element for `key`, made the first time; `layer` order: rest outlines, dots, outlines, chips. */
	const take = (key: string, className: string, level: number) => {
		used.add(key);
		let found = pool.get(key);
		if (!found) {
			found = (layer?.ownerDocument ?? document).createElement("div");
			found.className = className;
			found.style.setProperty("z-index", String(level));
			pool.set(key, found);
			layer?.append(found);
		}
		return found;
	};
	/** Removes what this drawing didn't use. */
	const prune = () => {
		for (const [key, element] of pool) {
			if (used.has(key)) continue;
			element.remove();
			pool.delete(key);
		}
	};

	const draw = () => {
		const layerNow = layer;
		const frame = parts?.frame;
		const overlay = parts?.overlay;
		if (!layerNow || !frame || !overlay) return;
		used = new Set();
		// Regions the page shows later are made editable by the agent: in Preview they aren't either.
		if (mode === "preview") applyMode();
		if (mode === "preview" || !doc) {
			prune();
			layerNow.hidden = true;
			return;
		}
		const canvas = frame.closest("[data-wc-canvas]") ?? frame.parentElement;
		const frameBox = frame.getBoundingClientRect();
		const canvasBox = canvas?.getBoundingClientRect() ?? frameBox;
		const clip = {
			left: Math.max(frameBox.left, canvasBox.left),
			top: Math.max(frameBox.top, canvasBox.top),
			right: Math.min(frameBox.right, canvasBox.right),
			bottom: Math.min(frameBox.bottom, canvasBox.bottom),
		};
		layerNow.hidden = false;
		layerNow.style.setProperty("left", `${clip.left}px`);
		layerNow.style.setProperty("top", `${clip.top}px`);
		layerNow.style.setProperty("width", `${Math.max(0, clip.right - clip.left)}px`);
		layerNow.style.setProperty("height", `${Math.max(0, clip.bottom - clip.top)}px`);
		const outer = (element: Element) => {
			const box = overlay.boxOf(element);
			if (!box || (box.width === 0 && box.height === 0)) return null;
			return {
				left: box.left - clip.left - OFFSET,
				top: box.top - clip.top - OFFSET,
				width: box.width + 2 * OFFSET,
				height: box.height + 2 * OFFSET,
			};
		};

		const editingRegion = editingNow();
		const toolbar = inner.snapshot().toolbar;
		const pointed = hovered?.isConnected ? hovered : null;
		const focused = armed?.isConnected ? armed : null;
		// A photo or link with its popover open, and a photo a file is dragged over (BA-15).
		const popped = poppedNow();
		const drop = popovers.snapshot().drop;
		const strong = new Set([editingRegion, focused, pointed, popped, drop].filter(Boolean));
		// Photos and links shown since (a new photo, a Site script's part) are given what Edit needs.
		preparePopped();

		// At rest: every area that may change, dashed.
		let rest = 0;
		for (const region of marked()) {
			if (strong.has(region)) continue;
			const box = outer(region);
			if (box) outline(`rest:${rest++}`, box, "rest");
		}
		// The dots of what changed, on the outline's corner: text from the page editing, photos and links here.
		let dots = 0;
		const poppedChanged = [...doc.querySelectorAll<HTMLElement>(POPPED)].filter((region) =>
			changes.has(
				`${region.getAttribute("data-wc-item")}|${(region.getAttribute("data-wc-field") ?? "").split(".")[0]}`,
			),
		);
		for (const region of [...changed, ...poppedChanged]) {
			if (!region.isConnected) continue;
			const box = outer(region);
			if (!box) continue;
			const dot = take(`dot:${dots++}`, "absolute box-border rounded-full border-2 border-white shadow-sm", 1);
			dot.dataset.wcClientMark = "changed";
			place(dot, { left: box.left - DOT_SIZE / 2, top: box.top - DOT_SIZE / 2, width: DOT_SIZE, height: DOT_SIZE });
			dot.style.setProperty("background-color", CHANGED);
		}
		// Locked, under the pointer: a grey outline and the reason on a lock chip.
		if (pointed && !pointed.matches(MARKED)) {
			const box = outer(pointed);
			if (box) {
				outline("locked", box, "locked");
				const name = pointed.matches("footer, [role='contentinfo']") ? said.footer : said.header;
				chip(box, { icon: "lock", name, hint: said.sameEverywhere, colour: LOCK_CHIP, kind: "locked" });
			}
		}
		// Under the pointer, with focus, being edited: solid, with the chip (unless a toolbar or a popover
		// names it). A photo a file is dragged over: as under the pointer, saying it takes the file.
		for (const region of new Set([pointed, focused, editingRegion, popped, drop])) {
			if (!region?.matches(MARKED) || !region.isConnected) continue;
			const box = outer(region);
			if (!box) continue;
			const isEditing = region === editingRegion || region === popped;
			const isDrop = region === drop && !isEditing;
			const isHover = isDrop || (region === pointed && !isEditing && region !== focused);
			const kind = isEditing ? "editing" : isHover ? "hover" : "focus";
			outline(kind, box, kind);
			if (region === popped || (isEditing && toolbar)) continue;
			const hint = isEditing ? null : isDrop ? said.dropHere : isHover ? said.clickToEdit : said.enterToEdit;
			const shape = region.matches(PHOTO_REGION) ? "image" : region.matches(LINK_REGION) ? "link" : "type";
			chip(box, { icon: shape, name: labelOf(region), hint, colour: MARK, kind });
		}
		prune();
	};

	const outline = (key: string, box: Box, kind: "rest" | "hover" | "focus" | "editing" | "locked") => {
		const drawn = take(`outline:${key}`, "absolute box-border rounded-[8px]", kind === "rest" ? 0 : 2);
		drawn.dataset.wcClientMark = kind;
		place(drawn, box);
		drawn.style.setProperty(
			"border",
			kind === "rest" ? `1.5px dashed ${MARK_SOFT}` : `2px solid ${kind === "locked" ? LOCK_OUTLINE : MARK}`,
		);
		drawn.style.setProperty("background-color", kind === "hover" ? MARK_TINT : "transparent");
	};

	const chip = (
		box: Box,
		look: { icon: ChipIcon; name: string; hint: string | null; colour: string; kind: string },
	) => {
		const drawn = take(
			`chip:${look.kind}`,
			"absolute flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-[7px] px-[9px] text-[12px] leading-4 text-white shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
			3,
		);
		drawn.dataset.wcClientChip = look.kind;
		drawn.style.setProperty("background-color", look.colour);
		// Its words are made again only when they change.
		const words = `${look.icon}|${look.name}|${look.hint ?? ""}`;
		if (drawn.dataset.wcWords !== words) {
			drawn.dataset.wcWords = words;
			const doc = drawn.ownerDocument;
			const name = doc.createElement("span");
			name.className = "font-semibold";
			name.textContent = look.name;
			drawn.replaceChildren(icon(doc, look.icon), name);
			if (look.hint) {
				const hint = doc.createElement("span");
				hint.className = "font-normal text-white/80";
				hint.textContent = look.hint;
				drawn.append(hint);
			}
		}
		// Above the outline's top left corner; inside its top when there is no room above.
		const above = box.top - CHIP_GAP - CHIP_HEIGHT;
		drawn.style.setProperty("left", `${Math.max(0, box.left - 2)}px`);
		drawn.style.setProperty("top", `${above >= 0 ? above : box.top + CHIP_GAP}px`);
	};

	// ── the wrapper ──

	const client: ClientEditing = {
		...inner,
		connect(next) {
			parts = next;
			next.overlay.outlines(false);
			const shellDoc = next.frame.ownerDocument;
			const canvas = next.frame.closest("[data-wc-canvas]") ?? next.frame.parentElement ?? shellDoc.body;
			layer = shellDoc.createElement("div");
			layer.className = "pointer-events-none fixed z-10 overflow-hidden";
			layer.dataset.wcClientMarks = "";
			layer.setAttribute("aria-hidden", "true");
			canvas.append(layer);
			stops.push(next.overlay.onDraw(draw));
			// The page editing asks the overlay for its marks: the dots are drawn here, on the outlines.
			const overlay: Overlay = {
				...next.overlay,
				marks(marks) {
					changed = marks.flatMap((mark) => (mark.kind === "changed" ? [mark.element] : []));
					people = marks.filter((mark) => mark.kind !== "changed");
					next.overlay.marks(mode === "preview" ? [] : people);
					redraw();
				},
			};
			const disconnect = inner.connect({ ...next, overlay });
			const disconnectPopovers = popovers.connect({ frame: next.frame, overlay: next.overlay });
			return () => {
				disconnectPopovers();
				disconnect();
				for (const stop of stops.splice(0)) stop();
				layer?.remove();
				layer = null;
				pool.clear();
				next.overlay.outlines(true);
				parts = null;
			};
		},
		page(document, address, isPage) {
			doc = document;
			hovered = null;
			armed = null;
			changed = [];
			changes = new Set();
			prepared.clear();
			popovers.page(document);
			inner.page(document, address, isPage);
		},
		pageState(state: PageState) {
			changes = new Set(state.changes.map((change) => `${change.item}|${change.key}`));
			popovers.pageState(state);
			inner.pageState(state);
			redraw();
		},
		ready(document) {
			inner.ready(document);
			if (document !== doc) return;
			applyMode();
			redraw();
		},
		event(kind, event) {
			if (mode === "preview") {
				// Nothing is edited in Preview: the history's keys and F6 still work.
				return kind === "keydown" ? inner.event(kind, event) : false;
			}
			// A file dragged over the page: a photo takes it (BA-15).
			if (kind === "dragover" || kind === "dragleave" || kind === "drop") return popovers.drag(kind, event);
			switch (kind) {
				case "pointermove": {
					const region = regionOf(event.target);
					const next = region ?? lockedOf(event.target);
					if (next !== hovered) {
						hovered = next;
						redraw();
					}
					break;
				}
				case "pointerleave":
					if (hovered) {
						hovered = null;
						redraw();
					}
					break;
				case "pointerdown": {
					pointing = true;
					window.setTimeout(() => {
						pointing = false;
					}, 0);
					const region = regionOf(event.target);
					// A press anywhere else in the page closes the popover open now.
					const popped = poppedNow();
					if (popped && region !== popped) popovers.close(false);
					// A click on the area that has focus starts editing it, where the click puts the caret.
					if (region && region === armed && !popovers.kindOf(region)) startEditing(region, false);
					break;
				}
				case "click": {
					// A photo or a link opens its popover; the page's own scripts don't see the click.
					const region = regionOf(event.target);
					if (region && popovers.kindOf(region)) {
						armed = null;
						popovers.open(region);
						return true;
					}
					break;
				}
				case "focusin": {
					const region = regionOf(event.target);
					if (!region) break;
					// From the pointer, focus is editing; from the keyboard, it waits for Enter. Focus coming back
					// to the region being edited (from its toolbar) goes on editing.
					if (!arming && (pointing || region === editingNow())) {
						armed = null;
						return inner.event(kind, event);
					}
					if (!arming) arm(region, true);
					return false;
				}
				case "focusout": {
					const region = regionOf(event.target);
					if (region && region === armed) {
						armed = null;
						redraw();
					}
					return inner.event(kind, event);
				}
				case "beforeinput": {
					const input = event as InputEvent;
					const region = regionOf(event.target);
					// An area with focus that isn't being edited: typing waits for Enter (Undo and Redo don't).
					if (region && region === armed && !KEPT_INPUT.has(input.inputType)) return true;
					return inner.event(kind, event);
				}
				case "keydown": {
					const key = event as KeyboardEvent;
					const handled = keyDown(key);
					if (handled) return true;
					return inner.event(kind, event);
				}
				default:
					break;
			}
			return inner.event(kind, event);
		},
		setMode(next) {
			if (next === mode) return;
			popovers.close(false);
			const editingRegion = editingNow();
			// What is being edited is saved first.
			if (next === "preview" && editingRegion) inner.tools.left(null);
			if (next === "preview") {
				armed?.blur();
				editingRegion?.blur();
			}
			mode = next;
			hovered = null;
			armed = null;
			applyMode();
			parts?.overlay.marks(mode === "preview" ? [] : people);
			redraw();
		},
	};

	/** The keys of SPEC 13.9 in the page: Tab between marked areas, Enter edits, Escape finishes. */
	const keyDown = (key: KeyboardEvent): boolean => {
		if (key.altKey || key.ctrlKey || key.metaKey) return false;
		const region = regionOf(key.target);
		const editingRegion = editingNow();
		switch (key.key) {
			case "Tab": {
				const win = view();
				const from = win && key.target instanceof win.Element ? (region ?? key.target) : doc?.body;
				if (!from) return false;
				const next = nextFrom(from, key.shiftKey);
				// Past the last area (or before the first) the browser's own Tab goes on.
				if (!next) return false;
				moveTo(next);
				return true;
			}
			case " ":
			case "Enter": {
				// A photo or a link with focus opens its popover (a photo also with Space, as a button).
				if (region && popovers.kindOf(region) && (key.key === "Enter" || region.matches(PHOTO_REGION))) {
					armed = null;
					popovers.open(region);
					return true;
				}
				if (key.key === " ") return false;
				if (region && region === armed) {
					startEditing(region, true);
					return true;
				}
				// Plain text is one line: Enter finishes it, as a click outside does (SPEC 13.3).
				if (region && region === editingRegion && region.getAttribute("data-wc-type") !== "richText") {
					finish(region);
					return true;
				}
				return false;
			}
			case "Escape": {
				if (region && region === editingRegion) {
					finish(region);
					return true;
				}
				return options.closePanel();
			}
			default:
				return false;
		}
	};

	return client;
}

type Box = { left: number; top: number; width: number; height: number };

function place(target: HTMLElement, box: Box): void {
	target.style.setProperty("left", `${box.left}px`);
	target.style.setProperty("top", `${box.top}px`);
	target.style.setProperty("width", `${box.width}px`);
	target.style.setProperty("height", `${box.height}px`);
}

type ChipIcon = "type" | "lock" | "image" | "link";

/** The icon set's "type", "lock", "image" and "link", drawn in the shell's document at 13 px. */
const ICONS: Record<ChipIcon, string[]> = {
	type: ["M12 4v16", "M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2", "M9 20h6"],
	image: [
		"M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
		"M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
		"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
	],
	link: [
		"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
		"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
	],
	lock: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z", "M7 11V7a5 5 0 0 1 10 0v4"],
};

function icon(doc: Document, name: ChipIcon): SVGSVGElement {
	const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
	for (const [attribute, value] of [
		["viewBox", "0 0 24 24"],
		["width", "13"],
		["height", "13"],
		["fill", "none"],
		["stroke", "currentColor"],
		["stroke-width", "2"],
		["stroke-linecap", "round"],
		["stroke-linejoin", "round"],
		["aria-hidden", "true"],
	] as const)
		svg.setAttribute(attribute, value);
	for (const d of ICONS[name]) {
		const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}
