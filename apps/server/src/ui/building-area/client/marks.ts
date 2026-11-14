import { TEXT_REGION } from "../agent/contract.ts";
import { fill, type Words } from "../api.ts";
import { nameOf, type Overlay, type OverlayMark } from "../canvas/overlay.ts";
import type { RegionSaving } from "../canvas/regions.ts";
import type { PageEditing } from "../editing/editing.ts";

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
 */
export type ClientEditing = PageEditing & {
	/** Edit (the marks, typing) or Preview (no mark, nothing editable; links are followed). */
	setMode(mode: ClientMode): void;
};

export type ClientMode = "edit" | "preview";

/** What a Member may change on the page now: its text regions (photos, Loop items and sections come later). */
export const MARKED = TEXT_REGION;

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
}): ClientEditing {
	const { inner, words, announce } = options;
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
		if (tell) announce(fill(said.armed, { name: nameOf(region, words) }));
		redraw();
	};

	/** Finishes editing an area: saved now, the toolbar put away; focus stays on it. */
	const finish = (region: HTMLElement) => {
		// The page editing saves it and puts its toolbar away, as when focus leaves it.
		inner.tools.left(null);
		arm(region, false);
		announce(fill(said.finished, { name: nameOf(region, words) }));
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

	/** Preview takes editing away from the page's regions; Edit gives it back as it was. */
	const applyMode = () => {
		if (!doc) return;
		for (const region of doc.querySelectorAll(MARKED)) {
			const now = region.getAttribute("contenteditable");
			if (mode === "preview") {
				if (now === "false") continue;
				if (now !== null) editable.set(region, now);
				region.setAttribute("contenteditable", "false");
			} else if (now === "false") {
				region.setAttribute("contenteditable", editable.get(region) ?? "true");
			}
		}
	};

	// ── drawing ──

	const draw = () => {
		const layerNow = layer;
		const frame = parts?.frame;
		const overlay = parts?.overlay;
		if (!layerNow || !frame || !overlay) return;
		layerNow.replaceChildren();
		// Regions the page shows later are made editable by the agent: in Preview they aren't either.
		if (mode === "preview") applyMode();
		if (mode === "preview" || !doc) {
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
		const strong = new Set([editingRegion, focused, pointed].filter(Boolean));

		// At rest: every area that may change, dashed.
		for (const region of marked()) {
			if (strong.has(region)) continue;
			const box = outer(region);
			if (box) layerNow.append(outline(box, "rest"));
		}
		// The dots of what changed, on the outline's corner.
		for (const region of changed) {
			if (!region.isConnected) continue;
			const box = outer(region);
			if (!box) continue;
			const dot = element("div", "absolute box-border rounded-full border-2 border-white shadow-sm");
			dot.dataset.wcClientMark = "changed";
			place(dot, { left: box.left - DOT_SIZE / 2, top: box.top - DOT_SIZE / 2, width: DOT_SIZE, height: DOT_SIZE });
			dot.style.setProperty("background-color", CHANGED);
			layerNow.append(dot);
		}
		// Locked, under the pointer: a grey outline and the reason on a lock chip.
		if (pointed && !pointed.matches(MARKED)) {
			const box = outer(pointed);
			if (box) {
				layerNow.append(outline(box, "locked"));
				const name = pointed.matches("footer, [role='contentinfo']") ? said.footer : said.header;
				layerNow.append(
					chip(box, { icon: "lock", name, hint: said.sameEverywhere, colour: LOCK_CHIP, kind: "locked" }),
				);
			}
		}
		// Under the pointer, with focus, being edited: solid, with the chip (unless a toolbar names it).
		for (const region of [pointed, focused, editingRegion]) {
			if (!region?.matches(MARKED) || !region.isConnected) continue;
			const box = outer(region);
			if (!box) continue;
			const isEditing = region === editingRegion;
			const isHover = region === pointed && !isEditing && region !== focused;
			layerNow.append(outline(box, isEditing ? "editing" : isHover ? "hover" : "focus"));
			if (isEditing && toolbar) continue;
			const hint = isEditing ? null : isHover ? said.clickToEdit : said.enterToEdit;
			layerNow.append(
				chip(box, {
					icon: "type",
					name: nameOf(region, words),
					hint,
					colour: MARK,
					kind: isEditing ? "editing" : isHover ? "hover" : "focus",
				}),
			);
		}
	};

	const element = (tag: string, className: string) => {
		const made = (layer?.ownerDocument ?? document).createElement(tag);
		made.className = className;
		return made;
	};

	const outline = (box: Box, kind: "rest" | "hover" | "focus" | "editing" | "locked") => {
		const drawn = element("div", "absolute box-border rounded-[8px]");
		drawn.dataset.wcClientMark = kind;
		place(drawn, box);
		if (kind === "rest") drawn.style.setProperty("border", `1.5px dashed ${MARK_SOFT}`);
		else drawn.style.setProperty("border", `2px solid ${kind === "locked" ? LOCK_OUTLINE : MARK}`);
		if (kind === "hover") drawn.style.setProperty("background-color", MARK_TINT);
		return drawn;
	};

	const chip = (
		box: Box,
		look: { icon: "type" | "lock"; name: string; hint: string | null; colour: string; kind: string },
	) => {
		const drawn = element(
			"div",
			"absolute flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-[7px] px-[9px] text-[12px] leading-4 text-white shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
		);
		drawn.dataset.wcClientChip = look.kind;
		drawn.style.setProperty("background-color", look.colour);
		const name = element("span", "font-semibold");
		name.textContent = look.name;
		drawn.append(icon(drawn.ownerDocument, look.icon), name);
		if (look.hint) {
			const hint = element("span", "font-normal text-white/80");
			hint.textContent = look.hint;
			drawn.append(hint);
		}
		// Above the outline's top left corner; inside its top when there is no room above.
		const above = box.top - CHIP_GAP - CHIP_HEIGHT;
		drawn.style.setProperty("left", `${Math.max(0, box.left - 2)}px`);
		drawn.style.setProperty("top", `${above >= 0 ? above : box.top + CHIP_GAP}px`);
		return drawn;
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
			return () => {
				disconnect();
				for (const stop of stops.splice(0)) stop();
				layer?.remove();
				layer = null;
				next.overlay.outlines(true);
				parts = null;
			};
		},
		page(document, address, isPage) {
			doc = document;
			hovered = null;
			armed = null;
			changed = [];
			inner.page(document, address, isPage);
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
					// A click on the area that has focus starts editing it, where the click puts the caret.
					const region = regionOf(event.target);
					if (region && region === armed) startEditing(region, false);
					break;
				}
				case "focusin": {
					const region = regionOf(event.target);
					if (!region) break;
					// From the pointer, focus is editing; from the keyboard, it waits for Enter.
					if (!arming && pointing) {
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
			case "Enter": {
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

/** The icon set's "type" and "lock", drawn in the shell's document at 13 px. */
const ICONS: Record<"type" | "lock", string[]> = {
	type: ["M12 4v16", "M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2", "M9 20h6"],
	lock: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z", "M7 11V7a5 5 0 0 1 10 0v4"],
};

function icon(doc: Document, name: "type" | "lock"): SVGSVGElement {
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
