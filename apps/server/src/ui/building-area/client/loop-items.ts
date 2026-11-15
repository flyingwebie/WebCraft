import { TEXT_REGION } from "../agent/contract.ts";
import { type EditAnswer, editRequests, fill, type PageState, type Words } from "../api.ts";
import { frameGeometry, type Overlay } from "../canvas/overlay.ts";
import type { SavingStatus } from "../canvas/regions.ts";
import { type ClientEditing, IN_ITEM, MARKED } from "./marks.ts";

/**
 * List items and query Loops in client editing (SPEC 13.3, BA-16; `client/05`): "a set of values opens
 * the side panel". The page marks each Loop it shows and each of its items with comments
 * (`<!--wc-loop loop:<id> <items|query> <name>-->`, `<!--wc-item <key>-->`), so nothing of its layout
 * changes; this finds them there and, for a Member:
 * - a Loop's own items are marked like what may change (dashed at rest; under the pointer solid, with
 *   a chip naming the item); one click, or Enter once one has focus, selects the item: a solid outline,
 *   a small bar on its top edge (its name, move earlier, move later, duplicate, remove; Alt+F10 reaches
 *   it), and the side panel with all its Fields (`ItemPanel.tsx`). Its values aren't typed in place;
 * - "Add an item" is a dashed card at the end of the list: a place made for it in the page (so it
 *   covers nothing), drawn here;
 * - a removed item can be put back from a toast for 8 seconds (`loop/restore`);
 * - a query Loop's items are Entries: a chip says where they come from and opens the Entry's own page
 *   in the shell (or its editor in the admin, when it has no page).
 * Tab and Shift+Tab go through items and the "Add" cards among the marked areas, in the page's order.
 * Every change goes through the Loop items' edit requests (`loop/*`), then the Loop is shown again as
 * the server renders it. Preview takes all of it away.
 *
 * `wrap` puts this around client editing's marks (`marks.ts`); React draws the bar, the chip and the
 * toast from `snapshot()` (`LoopItems.tsx`) and the panel (`ItemPanel.tsx`).
 */
export type LoopItems = {
	/** Client editing with the Loops' items around it: what happens in an item is handled here first. */
	wrap(editing: ClientEditing): ClientEditing;
	snapshot(): LoopItemsSnapshot;
	/** Called when the snapshot changes. Answers how to stop listening. */
	subscribe(listener: () => void): () => void;
	/** Called each time the page moves (what follows an item draws again). Answers how to stop. */
	onMove(listener: () => void): () => void;
	/** Where an item is on the shell's window: the box around its elements. */
	boxOf(key: string): DOMRect | null;
	/** Where the canvas is on the shell's window (what is drawn over the page stays inside it). */
	canvasBox(): DOMRect | null;
	/** Selects an item (null: none); with `panel`, its side panel opens (or stays open). */
	select(key: string | null, options?: { panel?: boolean }): void;
	/** Puts the side panel away; the item stays selected unless `deselect`, focus goes back to it with `focusItem`. */
	closePanel(options?: { deselect?: boolean; focusItem?: boolean }): void;
	/** Selects the item before (-1) or after (1) the selected one, its panel open. */
	step(delta: -1 | 1): void;
	/** The selected item moves one place earlier (-1) or later (1). */
	move(delta: -1 | 1): Promise<void>;
	duplicate(): Promise<void>;
	/** Removes the selected item (or `key`), offering Undo for 8 seconds. */
	remove(key?: string): Promise<void>;
	/** Puts back the item removed last. */
	restore(): Promise<void>;
	/** The toast is put away without putting the item back. */
	dismissRemoved(): void;
	/** Adds an item at the end of a Loop, selected with its panel open. */
	add(loopId: string): Promise<void>;
	/** The Loop item's Fields and values (`loop/get`) in the page's language. */
	load(key: string): Promise<EditAnswer<ItemForm>>;
	/** Saves some of an item's values (`loop/save`); the Loop is shown again a moment later. */
	save(key: string, values: Record<string, unknown>): Promise<EditAnswer<SavedItem>>;
	/** The pointer is over the query chip (it stays), or left it. */
	holdChip(held: boolean): void;
	/** Opens the Entry a query Loop's item shows (the chip's link). */
	openEntry(): void;
	/** Puts focus back on an item in the page (the chip's or the bar's Escape). */
	focusItem(key: string): void;
	/** The language the page is shown in (the item's values are read and saved in it). */
	language(): PageState["language"] | null;
	destroy(): void;
};

/** One Field of a Loop's items, as `loop/get` answers it. */
export type ItemField = {
	key: string;
	label: string;
	type: string;
	translatable?: boolean;
	multiple?: boolean;
	mode?: string;
	required?: boolean;
	options?: { value: string; label: string }[];
	fields?: ItemField[];
};

/** `loop/get`: the Loop, its items' Fields, and one item's values. */
export type ItemForm = { loop: { id: string; name: string }; fields: ItemField[]; item: Record<string, unknown> };

/** `loop/save`: the Loop's status, the item as stored, and what keeps it from being published. */
export type SavedItem = {
	status: string;
	item: Record<string, unknown>;
	problems: { at: string; rule?: string; message?: string }[];
};

/** Where a query Loop's item (an Entry) is changed (`loop/entries`). */
export type EntryLink = { id: string; title: string; href: string; page: boolean; postType?: string };

export type SelectedItem = {
	key: string;
	loopId: string;
	itemId: string;
	/** The item's name: its first text value on the page. */
	name: string;
	/** "Our bakes · item 2 of 4". */
	position: string;
	index: number;
	count: number;
	/** Whether the side panel shows its Fields. */
	panel: boolean;
	/** Whether the items run across (a row of cards: the bar's arrows point left and right) or down. */
	across: boolean;
	/** Bumped each time focus should go into the item bar (Alt+F10). */
	reach: number;
};

export type LoopItemsSnapshot = {
	selected: SelectedItem | null;
	/** The chip of a query Loop's item: under the pointer, or held (clicked, or focus on the item). */
	query: { key: string; title: string; from: string; link: EntryLink | null; held: boolean; reach: number } | null;
	/** The item removed last, for 8 seconds: its name and what puts it back. */
	removed: { name: string; at: number } | null;
	/** A change to a Loop is under way (the bar's buttons wait). */
	busy: boolean;
};

type ShownLoop = {
	id: string;
	source: "items" | "query";
	/** How Template markup names it (`our-bakes`). */
	name: string;
	/** For people: `Our bakes`. */
	label: string;
	start: Comment;
	end: Comment;
	/** Which of the Loop's appearances on the page it is (a Loop can show twice). */
	n: number;
	items: ShownItem[];
	/** The place made at the end of the list for "Add an item" (own items only). */
	add: HTMLElement | null;
};

type ShownItem = {
	key: string;
	/** The item's id (own items), or the Entry's (a query Loop's). */
	id: string;
	loop: ShownLoop;
	start: Comment;
	end: Comment;
	index: number;
	/** The item's first element, which takes focus. */
	focus: HTMLElement | null;
};

/** What the page's marks say: percent-encoded words after `wc-loop` or `wc-item`. */
function markWords(comment: Comment, kind: string): string[] | null {
	const text = comment.data;
	if (!text.startsWith(`${kind} `)) return null;
	try {
		return text
			.slice(kind.length + 1)
			.split(" ")
			.map((part) => decodeURIComponent(part));
	} catch {
		return null;
	}
}

/** A Loop's name for people: `our-bakes` reads "Our bakes". */
export function loopLabel(name: string): string {
	const words = name.replace(/[-_]+/g, " ").trim();
	return words ? `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}` : name;
}

/** The attribute on an item's first element given a way to be reached with Tab. */
const FOCUS_MARK = "data-wc-item-focus";
/** The attribute on the place made for "Add an item" at the end of a Loop's list (its Loop's id). */
const ADD_MARK = "data-wc-loop-add";

/** The outline's distance from the item, its corners, and the chip (as client editing's marks). */
const OFFSET = 6;
const RADIUS = 14;
const CHIP_HEIGHT = 26;
const CHIP_GAP = 6;
const MARK = "#4f46e5";
const MARK_SOFT = "#4f46e599";
const MARK_TINT = "#4f46e514";

/** The "Add an item" card: as tall as an item, at most this (a row of cards), or this in a list down. */
const ADD_MAX_HEIGHT = 112;
const ADD_DOWN_HEIGHT = 56;
const ADD_EMPTY_WIDTH = 240;

/** How long "{item} removed · Undo" stays (BA-16). */
export const REMOVED_FOR_MS = 8000;
/** How long the query chip waits before going when the pointer leaves its item (it can be reached). */
const CHIP_HIDE_MS = 300;
/** How long after a value is saved in the panel the Loop is shown again on the page. */
const REFRESH_AFTER_MS = 700;

export function loopItems(options: {
	token: string;
	words: Words;
	announce(text: string, urgent?: boolean): void;
	/** The Draft's state beside Publish: saving, saved (the page's state is read again), could not save. */
	saving(status: SavingStatus): void;
	/** The item's side panel opened: the bar's panel (Page details, Sections) closes. One at a time. */
	panelOpened(): void;
	/** Opens a page of the Site in the shell (a query Loop's Entry). */
	openPage(path: string): void;
}): LoopItems {
	const { words, announce } = options;
	const said = words.client.items;
	const request = editRequests(options.token);
	const listeners = new Set<() => void>();
	const moves = new Set<() => void>();

	let snapshot: LoopItemsSnapshot = { selected: null, query: null, removed: null, busy: false };
	const set = (next: Partial<LoopItemsSnapshot>) => {
		snapshot = { ...snapshot, ...next };
		for (const listener of listeners) listener();
	};

	let parts: { frame: HTMLIFrameElement; overlay: Overlay } | null = null;
	let doc: Document | null = null;
	let mode: "edit" | "preview" = "edit";
	let language: PageState["language"] | null = null;
	let loops: ShownLoop[] = [];
	/** The item under the pointer, the item (or "Add" card) with focus, and the selected item. */
	let hovered: string | null = null;
	let armed: string | null = null;
	let armedAdd: string | null = null;
	let hoveredAdd: string | null = null;
	let selectedKey: string | null = null;
	let panel = false;
	let reach = 0;
	let chipReach = 0;
	/** A pointer was pressed in the page: the focus that follows isn't the keyboard's. */
	let pointing = false;
	/** The query item whose chip shows, and whether it stays (clicked, focus) or follows the pointer. */
	let chip: { key: string; held: boolean } | null = null;
	let chipHeld = false;
	let chipTimer: number | undefined;
	/** What puts back the item removed last, and the toast's timer. */
	let removed: { restore: string; loopId: string; name: string } | null = null;
	let removedTimer: number | undefined;
	/** Where each query Loop's Entry is changed, by Entry id. */
	const links = new Map<string, EntryLink>();
	const refreshTimers = new Map<string, number>();
	let observer: MutationObserver | null = null;
	let rescanFrame = 0;

	let layer: HTMLDivElement | null = null;
	const stops: (() => void)[] = [];

	const view = () => parts?.frame.contentWindow as (Window & typeof globalThis) | null | undefined;
	const isElement = (target: EventTarget | null): target is Element => {
		const win = view();
		return Boolean(win && target instanceof win.Element);
	};
	const redraw = () => parts?.overlay.schedule();
	const failed = (loop: ShownLoop | undefined, answer: EditAnswer<unknown>) =>
		announce(fill(said.failed, { loop: loop?.label ?? "", reason: answer.ok ? "" : answer.code }), true);

	// ── finding the Loops on the page ──

	/** The nodes between two marks. */
	const nodesOf = (range: { start: Comment; end: Comment }): Node[] => {
		const nodes: Node[] = [];
		for (let node = range.start.nextSibling; node && node !== range.end; node = node.nextSibling) nodes.push(node);
		return nodes;
	};
	const elementsOf = (range: { start: Comment; end: Comment }): HTMLElement[] =>
		nodesOf(range).filter((node): node is HTMLElement => node.nodeType === Node.ELEMENT_NODE) as HTMLElement[];

	const focusable = (element: HTMLElement) =>
		element.matches("a[href], button, input, select, textarea, [tabindex]") || element.isContentEditable;

	const find = (key: string | null): ShownItem | null => {
		if (!key) return null;
		for (const loop of loops) for (const item of loop.items) if (item.key === key) return item;
		return null;
	};

	/** The innermost item an element of the page is in. */
	const itemOf = (target: EventTarget | null): ShownItem | null => {
		if (!isElement(target)) return null;
		let found: ShownItem | null = null;
		for (const loop of loops) {
			for (const item of loop.items) {
				if (!elementsOf(item).some((element) => element === target || element.contains(target))) continue;
				// A Loop inside an item: its own item is the one meant.
				if (!found || found.start.compareDocumentPosition(item.start) & Node.DOCUMENT_POSITION_FOLLOWING) found = item;
			}
		}
		return found;
	};
	const addOf = (target: EventTarget | null): ShownLoop | null => {
		if (!isElement(target)) return null;
		const add = target.closest(`[${ADD_MARK}]`);
		return add ? (loops.find((loop) => loop.add === add) ?? null) : null;
	};

	/** The item's name: its first text value on the page, else its first words, else "Item 2". */
	const nameOf = (item: ShownItem): string => {
		const elements = elementsOf(item);
		for (const element of elements) {
			const region = element.matches(TEXT_REGION) ? element : element.querySelector(TEXT_REGION);
			const text = region?.textContent?.trim();
			if (text) return text;
		}
		const text = elements
			.map((element) => element.textContent ?? "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) return text.length > 60 ? `${text.slice(0, 59)}…` : text;
		return fill(said.untitled, { n: String(item.index + 1) });
	};
	const positionOf = (item: ShownItem) =>
		fill(said.position, { loop: item.loop.label, n: String(item.index + 1), count: String(item.loop.items.length) });

	/** The box around an item's elements, in the page's own pixels. */
	const pageBox = (elements: readonly Element[]): DOMRect | null => {
		let box: { left: number; top: number; right: number; bottom: number } | null = null;
		for (const element of elements) {
			for (const rect of element.getClientRects()) {
				if (rect.width === 0 && rect.height === 0) continue;
				box = box
					? {
							left: Math.min(box.left, rect.left),
							top: Math.min(box.top, rect.top),
							right: Math.max(box.right, rect.right),
							bottom: Math.max(box.bottom, rect.bottom),
						}
					: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
			}
		}
		return box ? new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top) : null;
	};
	/** A box of the page on the shell's window, through the frame's place and zoom. */
	const onShell = (rect: DOMRect | null): DOMRect | null => {
		const frame = parts?.frame;
		if (!rect || !frame) return null;
		const geometry = frameGeometry(frame);
		return new DOMRect(
			geometry.left + rect.left * geometry.scale,
			geometry.top + rect.top * geometry.scale,
			rect.width * geometry.scale,
			rect.height * geometry.scale,
		);
	};
	const itemBox = (item: ShownItem) => onShell(pageBox(elementsOf(item)));

	/** Whether a Loop's items run across (the second beside the first) rather than down. */
	const across = (loop: ShownLoop): boolean => {
		const [first, second] = loop.items.map((item) => pageBox(elementsOf(item)));
		if (first && second) return second.left >= first.right - 1 && second.top < first.bottom - 1;
		const parent = loop.end.parentElement;
		const win = view();
		if (!parent || !win) return false;
		const style = win.getComputedStyle(parent);
		if (style.display.includes("flex")) return !style.flexDirection.startsWith("column");
		if (style.display.includes("grid")) return style.gridTemplateColumns.trim().split(/\s+/).length > 1;
		return false;
	};

	/** The place at the end of a Loop's list where "Add an item" is drawn, made in the page so it covers nothing. */
	const placeAdd = (loop: ShownLoop) => {
		if (!doc) return;
		const parent = loop.end.parentElement;
		// It sits right before the Loop's closing mark, where it was put.
		const before = loop.end.previousSibling;
		let add =
			before?.nodeType === Node.ELEMENT_NODE && (before as Element).getAttribute(ADD_MARK) === loop.id
				? (before as HTMLElement)
				: null;
		if (!add) {
			const listed = parent?.localName === "ul" || parent?.localName === "ol";
			add = doc.createElement(listed ? "li" : "div");
			add.setAttribute(ADD_MARK, loop.id);
			add.setAttribute("tabindex", "0");
			add.setAttribute("role", "button");
			for (const [name, value] of [
				["box-sizing", "border-box"],
				["list-style", "none"],
				["margin-block", "0"],
				["padding", "0"],
				["border", "0"],
				["background", "none"],
				["box-shadow", "none"],
				["outline", "none"],
				["cursor", "pointer"],
				["flex", "none"],
				["align-self", "flex-start"],
				["max-width", "100%"],
			] as const)
				add.style.setProperty(name, value);
			loop.end.before(add);
		}
		add.setAttribute("aria-label", fill(said.addTo, { loop: loop.label }));
		const last = loop.items.at(-1);
		const box = last ? pageBox(elementsOf(last)) : null;
		const runsAcross = across(loop);
		const width = box ? box.width : ADD_EMPTY_WIDTH;
		const height = box && runsAcross ? Math.min(box.height, ADD_MAX_HEIGHT) : ADD_DOWN_HEIGHT;
		add.style.setProperty("width", `${Math.round(width)}px`);
		add.style.setProperty("height", `${Math.round(height)}px`);
		loop.add = add;
	};

	/** Reads the page's Loops and their items again (the page changed), and gets them ready for Edit. */
	const scan = () => {
		if (!doc?.body) {
			loops = [];
			return;
		}
		const found: ShownLoop[] = [];
		const open: ShownLoop[] = [];
		const seen = new Map<string, number>();
		let item: { key: string; start: Comment } | null = null;
		const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const comment = node as Comment;
			const loopWords = markWords(comment, "wc-loop");
			const opened = open.at(-1);
			if (loopWords) {
				const [id = "", source = "", name = ""] = loopWords;
				const loopId = id.replace(/^loop:/, "");
				const n = seen.get(loopId) ?? 0;
				seen.set(loopId, n + 1);
				open.push({
					id: loopId,
					source: source === "items" ? "items" : "query",
					name,
					label: loopLabel(name),
					start: comment,
					end: comment,
					n,
					items: [],
					add: null,
				});
			} else if (comment.data === "/wc-loop" && opened) {
				opened.end = comment;
				open.pop();
				found.push(opened);
			} else if (opened && markWords(comment, "wc-item")) {
				item = { key: markWords(comment, "wc-item")?.[0] ?? "", start: comment };
			} else if (opened && comment.data === "/wc-item" && item) {
				const key = item.key;
				opened.items.push({
					key,
					id: key.split(":").at(-1) ?? "",
					loop: opened,
					start: item.start,
					end: comment,
					index: opened.items.length,
					focus: null,
				});
				item = null;
			}
		}
		loops = found;
		// A Loop's own item's values are changed in its panel, not typed in place.
		for (const region of doc.querySelectorAll(`${TEXT_REGION}${IN_ITEM}`)) {
			if (region.getAttribute("contenteditable") !== "false") region.setAttribute("contenteditable", "false");
		}
		for (const loop of loops) {
			for (const each of loop.items) {
				const [first] = elementsOf(each);
				each.focus = first ?? null;
				if (mode === "edit" && first && !focusable(first)) {
					first.setAttribute("tabindex", "0");
					first.setAttribute(FOCUS_MARK, "");
				}
			}
			if (mode === "edit" && loop.source === "items") placeAdd(loop);
		}
		for (const add of doc.querySelectorAll<HTMLElement>(`[${ADD_MARK}]`)) {
			if (mode === "preview" || !loops.some((loop) => loop.add === add)) add.remove();
		}
		void loadLinks();
		// What was selected or held follows the items as the page shows them now.
		if (selectedKey && !find(selectedKey)) {
			selectedKey = null;
			panel = false;
		}
		if (chip && !find(chip.key)) chip = null;
		publish();
		redraw();
	};

	/** Takes away what Edit gave the page: the items' Tab stops and the "Add" places (Preview, leaving). */
	const unprepare = () => {
		if (!doc) return;
		for (const element of doc.querySelectorAll(`[${FOCUS_MARK}]`)) {
			element.removeAttribute("tabindex");
			element.removeAttribute(FOCUS_MARK);
		}
		for (const add of doc.querySelectorAll(`[${ADD_MARK}]`)) add.remove();
		for (const loop of loops) loop.add = null;
	};

	/** What React draws: the selected item, the query chip, the toast. */
	const publish = () => {
		const item = find(selectedKey);
		const chipItem = chip ? find(chip.key) : null;
		const link = chipItem ? (links.get(chipItem.id) ?? null) : null;
		set({
			selected: item
				? {
						key: item.key,
						loopId: item.loop.id,
						itemId: item.id,
						name: nameOf(item),
						position: positionOf(item),
						index: item.index,
						count: item.loop.items.length,
						panel,
						across: across(item.loop),
						reach,
					}
				: null,
			query:
				chip && chipItem
					? {
							key: chip.key,
							title: link?.title ?? nameOf(chipItem),
							from: link?.postType ? fill(said.query.from, { type: link.postType }) : said.query.fromEntries,
							link,
							held: chip.held,
							reach: chipReach,
						}
					: null,
			removed: removed ? { name: removed.name, at: snapshot.removed?.at ?? Date.now() } : null,
		});
	};

	/** Where each query Loop's Entry is changed, for its chip's link (`loop/entries`). */
	const loadLinks = async () => {
		const wanted = [
			...new Set(
				loops
					.filter((loop) => loop.source === "query")
					.flatMap((loop) => loop.items.map((item) => item.id))
					.filter((id) => id && !links.has(id)),
			),
		];
		if (wanted.length === 0) return;
		const answer = await request<{ entries: EntryLink[] }>("loop/entries", {
			entries: wanted,
			...(language ? { language: language.code } : {}),
		});
		if (!answer.ok) return;
		for (const link of answer.data.entries) links.set(link.id, link);
		if (chip) publish();
	};

	const scheduleScan = () => {
		const win = view();
		if (!win || rescanFrame) return;
		rescanFrame = win.requestAnimationFrame(() => {
			rescanFrame = 0;
			scan();
		});
	};

	/** Watches the page for parts shown again (a Filter's results, a Site script's): their Loops are read again. */
	const watch = (document: Document) => {
		observer?.disconnect();
		const win = document.defaultView as (Window & typeof globalThis) | null;
		if (!win || !document.body) return;
		observer = new win.MutationObserver((records) => {
			const ours = (node: Node) => node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute(ADD_MARK);
			const theirs = records.some(
				(record) =>
					[...record.addedNodes].some((node) => !ours(node)) || [...record.removedNodes].some((node) => !ours(node)),
			);
			if (theirs) scheduleScan();
		});
		observer.observe(document.body, { childList: true, subtree: true });
	};

	/**
	 * Shows a Loop again as the server renders it now (the page in Edit mode read again): every
	 * appearance of it on the page takes the fresh one's nodes.
	 */
	const refreshLoop = async (loopId: string): Promise<void> => {
		const win = view();
		const page = doc;
		if (!win || !page) return;
		let fresh: Document;
		try {
			const response = await fetch(win.location.href, { credentials: "same-origin", cache: "no-store" });
			if (!response.ok) return;
			fresh = new DOMParser().parseFromString(await response.text(), "text/html");
		} catch {
			return;
		}
		if (page !== doc) return;
		const wanted: { start: Comment; end: Comment }[] = [];
		const stack: { id: string; start: Comment }[] = [];
		const walker = fresh.createTreeWalker(fresh.body, NodeFilter.SHOW_COMMENT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const comment = node as Comment;
			const loopWords = markWords(comment, "wc-loop");
			if (loopWords) stack.push({ id: (loopWords[0] ?? "").replace(/^loop:/, ""), start: comment });
			else if (comment.data === "/wc-loop") {
				const started = stack.pop();
				if (started?.id === loopId) wanted.push({ start: started.start, end: comment });
			}
		}
		// Bottom-up: a Loop nested in another is replaced with it.
		const shown = loops.filter((loop) => loop.id === loopId).sort((a, b) => a.n - b.n);
		for (const [index, loop] of shown.entries()) {
			const from = wanted[index];
			if (!from || !loop.start.isConnected) continue;
			for (const node of nodesOf(loop)) node.parentNode?.removeChild(node);
			const nodes = nodesOf(from).map((node) => page.importNode(node, true));
			loop.end.before(...nodes);
		}
		scan();
	};

	/** Runs one of the Loop items' edit requests on a Loop, then shows the Loop again. */
	const act = async <T>(loop: ShownLoop, action: string, body: object): Promise<T | null> => {
		set({ busy: true });
		options.saving("saving");
		const answer = await request<T>(action, { loop: loop.id, ...body });
		if (!answer.ok) {
			set({ busy: false });
			options.saving("failed");
			failed(loop, answer);
			return null;
		}
		await refreshLoop(loop.id);
		set({ busy: false });
		options.saving("saved");
		return answer.data;
	};

	// ── selecting, focus ──

	const select = (key: string | null, opts: { panel?: boolean } = {}) => {
		const item = find(key);
		if (item && item.loop.source !== "items") return;
		const was = panel;
		selectedKey = item?.key ?? null;
		if (opts.panel !== undefined) panel = opts.panel && Boolean(item);
		if (!item) panel = false;
		if (panel && !was) options.panelOpened();
		publish();
		redraw();
	};

	/** Focus on an item (or an "Add" card) in the page, from the keyboard: it says what it is, nothing opens. */
	const arm = (item: ShownItem | null, tell: boolean) => {
		armed = item?.key ?? null;
		armedAdd = null;
		if (item && tell) {
			if (item.loop.source === "items") {
				announce(
					fill(said.armed, {
						name: nameOf(item),
						n: String(item.index + 1),
						count: String(item.loop.items.length),
						loop: item.loop.label,
					}),
				);
			} else {
				const link = links.get(item.id);
				announce(
					fill(said.query.armed, {
						title: link?.title ?? nameOf(item),
						from: link?.postType ? fill(said.query.from, { type: link.postType }) : said.query.fromEntries,
					}),
				);
			}
		}
		redraw();
	};

	/** Focus on an item's first element in the page (the frame first). */
	const focusOn = (element: HTMLElement | null | undefined) => {
		const frame = parts?.frame;
		if (!frame || !element?.isConnected) return;
		frame.focus();
		frame.contentWindow?.focus();
		element.focus({ preventScroll: true });
		element.scrollIntoView({ block: "nearest", inline: "nearest" });
	};
	const focusItem = (key: string) => {
		const item = find(key);
		if (!item) return;
		focusOn(item.focus);
		arm(item, false);
	};

	const showChip = (key: string, held: boolean) => {
		window.clearTimeout(chipTimer);
		// Held stays held while the pointer comes and goes over the same item.
		const stays = held || (chip?.key === key && chip.held);
		if (chip?.key === key && chip.held === stays) return;
		chip = { key, held: stays };
		publish();
	};
	const hideChipSoon = () => {
		window.clearTimeout(chipTimer);
		if (!chip || chip.held) return;
		chipTimer = window.setTimeout(() => {
			if (chipHeld || chip?.held) return;
			chip = null;
			publish();
		}, CHIP_HIDE_MS);
	};
	const dropChip = () => {
		window.clearTimeout(chipTimer);
		if (!chip) return;
		chip = null;
		publish();
	};

	// ── the order of Tab in the page ──

	/** Every place Tab stops in the page while Edit is on: the marked areas, the items, the "Add" cards. */
	const stopsNow = (): HTMLElement[] => {
		if (!doc) return [];
		const all = new Set<HTMLElement>();
		for (const element of doc.querySelectorAll<HTMLElement>(MARKED)) all.add(element);
		for (const loop of loops) {
			for (const item of loop.items) if (item.focus) all.add(item.focus);
			if (loop.add) all.add(loop.add);
		}
		return [...all]
			.filter((element) => element.isConnected && element.getClientRects().length > 0)
			.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
	};
	const isOurs = (element: HTMLElement) =>
		element.hasAttribute(ADD_MARK) || loops.some((loop) => loop.items.some((item) => item.focus === element));

	/** The stop after (or before) `from`; a stop inside another counts as after it. */
	const nextStop = (from: Element, back: boolean): HTMLElement | null => {
		const all = stopsNow();
		const at = all.indexOf(from as HTMLElement);
		if (at >= 0) return all[at + (back ? -1 : 1)] ?? null;
		const isStart = from === doc?.body || from === doc?.documentElement;
		const after = (each: Element) => Boolean(from.compareDocumentPosition(each) & Node.DOCUMENT_POSITION_FOLLOWING);
		if (back) return [...all].reverse().find((each) => isStart || !after(each)) ?? null;
		return all.find((each) => isStart || after(each)) ?? null;
	};

	/** Keys in the page, before client editing's: Tab through items, Enter, Alt+F10, Escape. True when taken. */
	const keyDown = (key: KeyboardEvent): boolean => {
		const target = key.target;
		const item = itemOf(target);
		const add = addOf(target);
		if (key.key === "F10" && key.altKey && !key.ctrlKey && !key.metaKey && item) {
			if (item.loop.source === "items") {
				reach += 1;
				select(item.key);
			} else {
				chipReach += 1;
				showChip(item.key, true);
				publish();
			}
			return true;
		}
		if (key.altKey || key.ctrlKey || key.metaKey) return false;
		switch (key.key) {
			case "Tab": {
				const from = isElement(target) ? (target.closest<HTMLElement>(MARKED) ?? (target as HTMLElement)) : doc?.body;
				if (!from) return false;
				const next = nextStop(from, key.shiftKey);
				// Only the items and the "Add" cards are taken here; the marked areas are client editing's.
				if (!next || !isOurs(next)) return false;
				pointing = false;
				next.focus({ preventScroll: true });
				next.scrollIntoView({ block: "nearest", inline: "nearest" });
				return true;
			}
			case "Enter":
			case " ": {
				if (add) {
					void addItem(add.id);
					return true;
				}
				if (!item || item.focus !== target) return false;
				if (item.loop.source === "items") {
					select(item.key, { panel: true });
					return true;
				}
				if (key.key === "Enter") {
					showChip(item.key, true);
					openEntry();
					return true;
				}
				return false;
			}
			case "Escape": {
				if (item && selectedKey === item.key) {
					select(null);
					focusItem(item.key);
					return true;
				}
				if (item && chip?.key === item.key) {
					dropChip();
					return true;
				}
				return false;
			}
			default:
				return false;
		}
	};

	// ── changing items ──

	const selectedItem = () => find(selectedKey);

	const move = async (delta: -1 | 1) => {
		const item = selectedItem();
		if (!item || snapshot.busy) return;
		const to = item.index + delta;
		if (to < 0 || to >= item.loop.items.length) return;
		const data = await act<{ items: string[] }>(item.loop, "loop/move", { item: item.id, to });
		if (!data) return;
		select(item.key);
		announce(fill(said.moved, { n: String(data.items.indexOf(item.id) + 1), count: String(data.items.length) }));
	};

	const duplicate = async () => {
		const item = selectedItem();
		if (!item || snapshot.busy) return;
		const name = nameOf(item);
		const data = await act<{ item: string }>(item.loop, "loop/duplicate", { item: item.id });
		if (!data) return;
		select(`loop:${item.loop.id}:${data.item}`);
		announce(fill(said.duplicated, { name }));
	};

	const showRemoved = (next: { restore: string; loopId: string; name: string } | null) => {
		window.clearTimeout(removedTimer);
		removed = next;
		set({ removed: next ? { name: next.name, at: Date.now() } : null });
	};

	const remove = async (key?: string) => {
		const item = find(key ?? selectedKey);
		if (!item || snapshot.busy || item.loop.source !== "items") return;
		const name = nameOf(item);
		const loop = item.loop;
		const after = loop.items[item.index + 1]?.key ?? loop.items[item.index - 1]?.key ?? null;
		const data = await act<{ restore: string }>(loop, "loop/remove", { item: item.id });
		if (!data) return;
		select(null);
		showRemoved({ restore: data.restore, loopId: loop.id, name });
		announce(fill(said.removedHint, { name }));
		// Focus goes to the item that took its place, else the "Add" card.
		const next = find(after);
		if (next) focusItem(next.key);
		else focusOn(loops.find((each) => each.id === loop.id)?.add);
	};

	const restore = async () => {
		const was = removed;
		const loop = loops.find((each) => each.id === was?.loopId);
		if (!was || !loop || snapshot.busy) return;
		showRemoved(null);
		set({ busy: true });
		options.saving("saving");
		const answer = await request<{ item: string }>("loop/restore", { restore: was.restore });
		if (!answer.ok) {
			set({ busy: false });
			options.saving("failed");
			failed(loop, answer);
			return;
		}
		await refreshLoop(loop.id);
		set({ busy: false });
		options.saving("saved");
		focusItem(`loop:${loop.id}:${answer.data.item}`);
		announce(fill(said.restored, { name: was.name }));
	};

	const addItem = async (loopId: string) => {
		const loop = loops.find((each) => each.id === loopId && each.source === "items");
		if (!loop || snapshot.busy) return;
		const last = loop.items.at(-1);
		const data = await act<{ item: string }>(loop, "loop/add", { after: last?.id ?? null });
		if (!data) return;
		const key = `loop:${loop.id}:${data.item}`;
		find(key)?.focus?.scrollIntoView({ block: "nearest", inline: "nearest" });
		select(key, { panel: true });
		announce(fill(said.added, { loop: loop.label }));
	};

	const openEntry = () => {
		const item = chip ? find(chip.key) : null;
		const link = item ? links.get(item.id) : null;
		if (!link) return;
		dropChip();
		if (link.page) options.openPage(link.href);
		else window.open(link.href, "_blank", "noopener");
	};

	// ── drawing ──

	const pool = new Map<string, HTMLElement>();
	let used = new Set<string>();
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
	const prune = () => {
		for (const [key, element] of pool) {
			if (used.has(key)) continue;
			element.remove();
			pool.delete(key);
		}
	};

	const canvasBox = (): DOMRect | null => {
		const frame = parts?.frame;
		if (!frame) return null;
		const canvas = frame.closest("[data-wc-canvas]") ?? frame.parentElement;
		const frameBox = frame.getBoundingClientRect();
		const box = canvas?.getBoundingClientRect() ?? frameBox;
		const left = Math.max(frameBox.left, box.left);
		const top = Math.max(frameBox.top, box.top);
		return new DOMRect(
			left,
			top,
			Math.max(0, Math.min(frameBox.right, box.right) - left),
			Math.max(0, Math.min(frameBox.bottom, box.bottom) - top),
		);
	};

	const draw = () => {
		const layerNow = layer;
		const clip = canvasBox();
		if (!layerNow || !clip) return;
		used = new Set();
		if (mode === "preview" || !doc) {
			prune();
			layerNow.hidden = true;
			for (const listener of moves) listener();
			return;
		}
		layerNow.hidden = false;
		place(layerNow, { left: clip.left, top: clip.top, width: clip.width, height: clip.height });
		const outer = (box: DOMRect | null, offset = OFFSET) =>
			box && (box.width > 0 || box.height > 0)
				? {
						left: box.left - clip.left - offset,
						top: box.top - clip.top - offset,
						width: box.width + 2 * offset,
						height: box.height + 2 * offset,
					}
				: null;
		for (const loop of loops) {
			for (const item of loop.items) {
				const box = outer(itemBox(item));
				if (!box) continue;
				const own = loop.source === "items";
				const isSelected = item.key === selectedKey;
				const isArmed = item.key === armed;
				const isHovered = item.key === hovered && !isSelected;
				if (!own) {
					// A query Loop's items have no marks at rest: the chip explains them; focus is still shown.
					if (isArmed) outline(`item:${item.key}`, box, "focus");
					continue;
				}
				const kind = isSelected ? "selected" : isArmed ? "focus" : isHovered ? "hover" : "rest";
				outline(`item:${item.key}`, box, kind);
				if (kind === "hover" || kind === "focus") {
					chipOn(
						`chip:${item.key}`,
						box,
						nameOf(item),
						kind === "hover" ? words.client.marks.clickToEdit : words.client.marks.enterToEdit,
					);
				}
			}
			if (loop.add) {
				const box = outer(onShell(pageBox([loop.add])), 0);
				if (box) addCard(loop, box);
			}
		}
		prune();
		for (const listener of moves) listener();
	};

	const outline = (key: string, box: Box, kind: "rest" | "hover" | "focus" | "selected") => {
		const drawn = take(`outline:${key}`, "absolute box-border", kind === "rest" ? 0 : 2);
		drawn.dataset.wcItemMark = kind;
		place(drawn, box);
		drawn.style.setProperty("border-radius", `${RADIUS}px`);
		drawn.style.setProperty("border", kind === "rest" ? `1.5px dashed ${MARK_SOFT}` : `2px solid ${MARK}`);
		drawn.style.setProperty("background-color", kind === "hover" ? MARK_TINT : "transparent");
	};

	const chipOn = (key: string, box: Box, name: string, hint: string) => {
		const drawn = take(
			key,
			"absolute flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-[7px] px-[9px] text-[12px] leading-4 text-white shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
			3,
		);
		drawn.dataset.wcItemChip = "";
		drawn.style.setProperty("background-color", MARK);
		const shown = `${name}|${hint}`;
		if (drawn.dataset.wcWords !== shown) {
			drawn.dataset.wcWords = shown;
			const owner = drawn.ownerDocument;
			const named = owner.createElement("span");
			named.className = "max-w-[240px] truncate font-semibold";
			named.textContent = name;
			const hinted = owner.createElement("span");
			hinted.className = "font-normal text-white/80";
			hinted.textContent = hint;
			drawn.replaceChildren(icon(owner, "list", 13), named, hinted);
		}
		const above = box.top - CHIP_GAP - CHIP_HEIGHT;
		drawn.style.setProperty("left", `${Math.max(0, box.left - 2)}px`);
		drawn.style.setProperty("top", `${above >= 0 ? above : box.top + CHIP_GAP}px`);
	};

	const addCard = (loop: ShownLoop, box: Box) => {
		const focused = armedAdd === loop.id;
		const drawn = take(
			`add:${loop.id}:${loop.n}`,
			"absolute box-border flex flex-col items-center justify-center gap-2 rounded-[12px] text-[13px] font-semibold",
			1,
		);
		drawn.dataset.wcLoopAddCard = loop.id;
		place(drawn, box);
		drawn.style.setProperty("color", MARK);
		drawn.style.setProperty("border", focused ? `2px solid ${MARK}` : `1.5px dashed ${MARK_SOFT}`);
		drawn.style.setProperty("background-color", focused || hoveredAdd === loop.id ? MARK_TINT : "transparent");
		const shown = said.add;
		if (drawn.dataset.wcWords !== shown) {
			drawn.dataset.wcWords = shown;
			const owner = drawn.ownerDocument;
			const text = owner.createElement("span");
			text.textContent = shown;
			drawn.replaceChildren(icon(owner, "plus", 20), text);
		}
	};

	// ── the wrapper ──

	const wrap = (editing: ClientEditing): ClientEditing => ({
		...editing,
		connect(next) {
			parts = next;
			const shellDoc = next.frame.ownerDocument;
			const canvas = next.frame.closest("[data-wc-canvas]") ?? next.frame.parentElement ?? shellDoc.body;
			layer = shellDoc.createElement("div");
			layer.className = "pointer-events-none fixed z-10 overflow-hidden";
			layer.dataset.wcItemMarks = "";
			layer.setAttribute("aria-hidden", "true");
			canvas.append(layer);
			stops.push(next.overlay.onDraw(draw));
			const disconnect = editing.connect(next);
			return () => {
				disconnect();
				for (const stop of stops.splice(0)) stop();
				layer?.remove();
				layer = null;
				pool.clear();
				parts = null;
			};
		},
		page(document, address, isPage) {
			observer?.disconnect();
			observer = null;
			doc = document;
			loops = [];
			hovered = null;
			armed = null;
			armedAdd = null;
			hoveredAdd = null;
			selectedKey = null;
			panel = false;
			chip = null;
			for (const timer of refreshTimers.values()) window.clearTimeout(timer);
			refreshTimers.clear();
			showRemoved(null);
			publish();
			editing.page(document, address, isPage);
		},
		ready(document) {
			editing.ready(document);
			if (document !== doc) return;
			scan();
			watch(document);
		},
		pageState(state) {
			const changed = language?.code !== state.language.code;
			language = state.language;
			if (changed) links.clear();
			editing.pageState(state);
			if (changed) void loadLinks();
		},
		event(kind, event) {
			if (mode === "preview" || !doc) return editing.event(kind, event);
			switch (kind) {
				case "pointermove": {
					const item = itemOf(event.target);
					const add = addOf(event.target);
					const key = item?.key ?? null;
					if (key !== hovered || (add?.id ?? null) !== hoveredAdd) {
						hovered = key;
						hoveredAdd = add?.id ?? null;
						redraw();
					}
					if (item && item.loop.source === "query") showChip(item.key, false);
					else hideChipSoon();
					break;
				}
				case "pointerleave":
					if (hovered || hoveredAdd) {
						hovered = null;
						hoveredAdd = null;
						redraw();
					}
					hideChipSoon();
					break;
				case "pointerdown":
					pointing = true;
					window.setTimeout(() => {
						pointing = false;
					}, 0);
					break;
				case "click": {
					const add = addOf(event.target);
					if (add) {
						void addItem(add.id);
						return true;
					}
					const item = itemOf(event.target);
					if (item?.loop.source === "items") {
						select(item.key, { panel: true });
						return true;
					}
					if (item) {
						showChip(item.key, true);
						return true;
					}
					// A click anywhere else in the page puts the item and the chip away.
					if (selectedKey) select(null);
					if (chip) dropChip();
					break;
				}
				case "focusin": {
					const add = addOf(event.target);
					if (add) {
						armed = null;
						armedAdd = add.id;
						redraw();
						break;
					}
					const item = itemOf(event.target);
					if (item && item.focus === event.target) {
						arm(item, !pointing);
						if (item.loop.source === "query" && !pointing) showChip(item.key, true);
					}
					break;
				}
				case "focusout": {
					const item = itemOf(event.target);
					const add = addOf(event.target);
					if ((item && item.key === armed) || add) {
						armed = null;
						armedAdd = null;
						redraw();
					}
					if (item?.loop.source === "query" && chip?.key === item.key && !pointing) {
						window.setTimeout(() => {
							// Focus went to the chip's own link: it stays.
							if (!document.activeElement?.closest("[data-wc-query-chip]")) dropChip();
						}, 0);
					}
					// Nothing in an item is typed in place: there is nothing to save as focus leaves it.
					if (item || add) return true;
					break;
				}
				case "beforeinput":
				case "input":
					if (itemOf(event.target)) return true;
					break;
				case "keydown":
					if (keyDown(event as KeyboardEvent)) return true;
					break;
				default:
					break;
			}
			return editing.event(kind, event);
		},
		setMode(next) {
			if (next !== mode) {
				mode = next;
				hovered = null;
				armed = null;
				armedAdd = null;
				hoveredAdd = null;
				if (next === "preview") {
					selectedKey = null;
					panel = false;
					chip = null;
					unprepare();
					publish();
				} else scan();
				redraw();
			}
			editing.setMode(next);
		},
		destroy() {
			observer?.disconnect();
			editing.destroy();
		},
	});

	return {
		wrap,
		snapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		onMove(listener) {
			moves.add(listener);
			return () => {
				moves.delete(listener);
			};
		},
		boxOf(key) {
			const item = find(key);
			return item ? itemBox(item) : null;
		},
		canvasBox,
		select,
		closePanel(opts = {}) {
			const key = selectedKey;
			panel = false;
			if (opts.deselect) selectedKey = null;
			publish();
			redraw();
			if (opts.focusItem && key) focusItem(key);
		},
		step(delta) {
			const item = selectedItem();
			const next = item?.loop.items[item.index + delta];
			if (!next) return;
			next.focus?.scrollIntoView({ block: "nearest", inline: "nearest" });
			select(next.key, { panel: true });
		},
		move,
		duplicate,
		remove,
		restore,
		dismissRemoved: () => showRemoved(null),
		add: addItem,
		load(key) {
			const item = find(key);
			return request<ItemForm>("loop/get", {
				loop: item?.loop.id ?? key.split(":")[1],
				item: item?.id ?? key.split(":")[2],
				...(language ? { language: language.code } : {}),
			});
		},
		async save(key, values) {
			const [, loopId = "", itemId = ""] = key.split(":");
			options.saving("saving");
			const answer = await request<SavedItem>("loop/save", {
				loop: loopId,
				item: itemId,
				values,
				...(language ? { language: language.code } : {}),
			});
			if (!answer.ok) {
				options.saving("failed");
				failed(
					loops.find((loop) => loop.id === loopId),
					answer,
				);
				return answer;
			}
			options.saving("saved");
			// The page shows the item as stored a moment later (once typing has stopped).
			window.clearTimeout(refreshTimers.get(loopId));
			refreshTimers.set(
				loopId,
				window.setTimeout(() => {
					refreshTimers.delete(loopId);
					void refreshLoop(loopId);
				}, REFRESH_AFTER_MS),
			);
			return answer;
		},
		holdChip(held) {
			chipHeld = held;
			if (held) window.clearTimeout(chipTimer);
			else hideChipSoon();
		},
		openEntry,
		focusItem,
		language: () => language,
		destroy() {
			observer?.disconnect();
			window.clearTimeout(chipTimer);
			window.clearTimeout(removedTimer);
			for (const timer of refreshTimers.values()) window.clearTimeout(timer);
			listeners.clear();
			moves.clear();
		},
	};
}

type Box = { left: number; top: number; width: number; height: number };

function place(target: HTMLElement, box: Box): void {
	target.style.setProperty("left", `${box.left}px`);
	target.style.setProperty("top", `${box.top}px`);
	target.style.setProperty("width", `${box.width}px`);
	target.style.setProperty("height", `${box.height}px`);
}

/** The icon set's "list" and "plus", drawn in the shell's document. */
const ICONS = {
	list: ["M3 12h.01", "M3 18h.01", "M3 6h.01", "M8 12h13", "M8 18h13", "M8 6h13"],
	plus: ["M5 12h14", "M12 5v14"],
} as const;

function icon(owner: Document, name: keyof typeof ICONS, size: number): SVGSVGElement {
	const svg = owner.createElementNS("http://www.w3.org/2000/svg", "svg");
	for (const [attribute, value] of [
		["viewBox", "0 0 24 24"],
		["width", String(size)],
		["height", String(size)],
		["fill", "none"],
		["stroke", "currentColor"],
		["stroke-width", "2"],
		["stroke-linecap", "round"],
		["stroke-linejoin", "round"],
		["aria-hidden", "true"],
	] as const)
		svg.setAttribute(attribute, value);
	for (const d of ICONS[name]) {
		const path = owner.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}
