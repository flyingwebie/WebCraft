import {
	type Block,
	CALLOUT_TONES,
	type CalloutTone,
	type InlineText,
	isSafeLink,
	newBlockId,
	type Run,
	videoAt,
} from "@webcraft/renderer/body/editing";

import type { BarKit, BodyTools, PresenceTarget, SharedDraft } from "../site/edit-bar/kit.ts";
import {
	caretOffset,
	caretOnEdgeLine,
	joinRuns,
	placeCaret,
	runsFromElement,
	runsLength,
	runsToHtml,
	splitRuns,
} from "./inline-dom.ts";
import {
	allowedChoices,
	type BlockChoice,
	type BodyComponentChoice,
	choiceOf,
	isTextBlock,
	itemsOf,
	type Line,
	linesOf,
	matches,
	maxDepth,
	moveItem,
	newBlock,
	newComponentBlock,
	PARAGRAPH,
	type PropField,
	propDefaultText,
	propNeeded,
	SHORTCUTS,
	turnInto,
	WHOLE_SHORTCUTS,
} from "./model.ts";

/**
 * The block editor in Edit mode (#79): a page's body, edited Block by Block where it shows, with the
 * same model as the admin's block editor (`model.ts`, `inline-dom.ts`). The page marks the body's
 * element as its region (`data-wc-type="body"`) and each Block with comments; this part turns each
 * text Block into the element it renders as, made editable (a paragraph stays a `<p>`, a heading an
 * `<h2>`), and keeps what the server rendered for the others (an image, a video, a Component),
 * which open their own forms.
 *
 * - `/` in an empty paragraph (or Add Block) opens the Block chooser: the Blocks the Field allows and
 *   the Components it allows, whose Props are filled in a form before they go in.
 * - Markdown shortcuts work while typing (`## `, `- `, `1. `, `> `, ` ``` `, `---`).
 * - The focused Block's tools (Alt+F10 from the text): a drag handle (on phones, Move up and Move
 *   down instead), Add Block, formatting for text, and a menu (turn into, edit, move, remove).
 * - What is pasted is converted by the server (`body/paste`); pasted image files go to the Media
 *   library (`media/upload`) and into image Blocks.
 * - Changes enter the page's shared Draft immediately (Co-editing), with batched saves, else `save`;
 *   others' changes show in every Block while the focused part keeps its caret.
 *
 * It is bundled into one file the editing bar loads on pages with a body (`assets.ts`), and works
 * through the bar's kit: its words, requests, layer and sheets.
 */
export function bodyTools(kit: BarKit): BodyTools {
	const { doc, el, button, icon, word, call, later, cancel, announce } = kit;

	type Problem = { at: string; rule?: string; message?: string };
	type Check = { at: string; check: string; detail?: string; message?: string };
	type BodyData = {
		label: string;
		language: string;
		blocks: Block[];
		blocksOff: string[];
		components: BodyComponentChoice[];
		problems: Problem[];
		checks: Check[];
	};
	/** One Block as the page shows it while it is edited. */
	type View = {
		block: Block;
		/** What the Block shows on the page: its own element, or a wrapper around what the server rendered. */
		root: HTMLElement;
		/** Its editable parts, by name (`text`, `item:2`, `cell:1:0`, `summary`, `code`). */
		parts: Map<string, HTMLElement>;
		/** A list's lines, as they are edited. */
		lines?: Line[];
	};
	type Body = {
		region: HTMLElement;
		item: string;
		field: string;
		data: BodyData;
		blocks: Block[];
		views: Map<string, View>;
		saveTimer: number;
		pendingSave?: SharedDraft;
		checkTimer: number;
		unlisten: (() => void) | null;
	};
	type Place = { body: Body; id: string };

	const bodies = new Map<HTMLElement, Body>();
	const loading = new Set<HTMLElement>();
	let on = true;
	/** The Block whose tools show. */
	let current: Place | null = null;
	/** A popup or sheet open now, and how to close it. */
	let open: { close(focus: boolean): void } | null = null;
	const toolbar = el("div", { class: "body-toolbar", role: "toolbar", hidden: "" });
	const notes = el("ul", { class: "body-notes", hidden: "" });
	const dropLine = el("div", { class: "body-drop", "aria-hidden": "true", hidden: "" });
	kit.layer.append(toolbar, notes, dropLine);

	const phone = () => kit.phone() || kit.win.matchMedia("(pointer: coarse)").matches;

	// -------------------------------------------------------------------------------------------
	// Finding the bodies and making them editable

	function setUp(scope: ParentNode): void {
		const found = [
			...(scope instanceof HTMLElement && scope.matches('[data-wc-type="body"]') ? [scope] : []),
			...scope.querySelectorAll<HTMLElement>('[data-wc-type="body"]'),
		];
		for (const region of found) {
			if (bodies.has(region) || loading.has(region)) continue;
			loading.add(region);
			void load(region).finally(() => loading.delete(region));
		}
	}

	async function load(region: HTMLElement): Promise<void> {
		const item = region.dataset.wcItem ?? "";
		const field = region.dataset.wcField ?? "";
		const answer = await call("body/get", { item, field, language: kit.state().language.code });
		if (!answer.ok || !region.isConnected) return;
		const data = answer.data as BodyData;
		const body: Body = {
			region,
			item,
			field,
			data,
			blocks: data.blocks,
			views: new Map(),
			saveTimer: 0,
			checkTimer: 0,
			unlisten: null,
		};
		bodies.set(region, body);
		const rendered = renderedBlocks(region);
		region.replaceChildren();
		region.setAttribute("role", "group");
		region.setAttribute("aria-label", word("body.region", { label: data.label }));
		for (const block of body.blocks) {
			const view = buildView(body, block, rendered.get(block.id));
			body.views.set(block.id, view);
			region.append(view.root);
		}
		if (body.blocks.length === 0) insertBlocks(body, null, [newBlock(PARAGRAPH)], false);
		region.addEventListener("input", (event) => onInput(body, event));
		region.addEventListener("keydown", (event) => onKey(body, event));
		region.addEventListener("focusin", (event) => onFocus(body, event));
		region.addEventListener("paste", (event) => void onPaste(body, event));
		region.addEventListener("pointerover", (event) => {
			if (current || !on) return;
			const id = blockIdOf(event.target);
			if (id) showTools({ body, id }, false);
		});
		markNotes(body);
		applyMode(body);
		listen(body);
	}

	/** What the server rendered for each Block, by id: the nodes between its marks. */
	function renderedBlocks(region: ParentNode): Map<string, Node[]> {
		const found = new Map<string, Node[]>();
		let id: string | null = null;
		let nodes: Node[] = [];
		for (const node of [...region.childNodes]) {
			if (node.nodeType === 8) {
				const text = (node as Comment).data;
				if (text.startsWith("wc-block ")) {
					id = text.slice("wc-block ".length);
					nodes = [];
				} else if (text === "/wc-block" && id) {
					found.set(id, nodes);
					id = null;
				}
				continue;
			}
			if (id) nodes.push(node);
		}
		return found;
	}

	function blockIdOf(target: EventTarget | null): string | null {
		const element = target instanceof Element ? target.closest<HTMLElement>("[data-wc-block-id]") : null;
		return element?.dataset.wcBlockId ?? null;
	}

	function partOf(target: EventTarget | null): HTMLElement | null {
		return target instanceof Element ? target.closest<HTMLElement>("[data-wc-block-part]") : null;
	}

	function blockLabel(body: Body, block: Block): string {
		const index = body.blocks.findIndex((each) => each.id === block.id);
		const choice = choiceOf(block);
		const type =
			block.type === "component"
				? word("body.components.label", { name: componentName(body, block.component) })
				: word(choice?.label ?? "body.choices.paragraph");
		return word("body.block", { type, number: index + 1 });
	}

	function componentName(body: Body, id: string): string {
		return body.data.components.find((component) => component.id === id)?.name ?? word("body.components.unknown");
	}

	// -------------------------------------------------------------------------------------------
	// Views: each Block as it shows on the page

	function editable(tag: string, body: Body, view: View, part: string, text: InlineText): HTMLElement {
		const element = doc.createElement(tag);
		element.setAttribute("contenteditable", "true");
		element.dataset.wcBlockPart = part;
		element.innerHTML = runsToHtml(text);
		if (view.block.type === "paragraph" && part === "text") element.dataset.wcPlaceholder = word("body.placeholder");
		// A list item's text has no element of its own to be named by: it is a named text box.
		if (tag === "div") {
			element.setAttribute("role", "textbox");
			element.setAttribute("aria-multiline", "true");
			element.setAttribute("aria-label", partLabel(body, view.block, part));
		}
		view.parts.set(part, element);
		return element;
	}

	function partLabel(body: Body, block: Block, part: string): string {
		const label = blockLabel(body, block);
		if (part.startsWith("item:")) return word("body.list.item", { number: Number(part.slice(5)) + 1 });
		if (part.startsWith("cell:")) {
			const [, row = "0", column = "0"] = part.split(":");
			return word("body.table.cell", { row: Number(row) + 1, column: Number(column) + 1 });
		}
		if (part === "summary") return word("body.toggle.summary", { block: label });
		if (block.type === "toggle" && part === "text") return word("body.toggle.text", { block: label });
		return label;
	}

	function buildView(body: Body, block: Block, rendered?: Node[]): View {
		const view: View = { block, root: doc.createElement("div"), parts: new Map() };
		switch (block.type) {
			case "paragraph":
				view.root = editable("p", body, view, "text", block.text);
				break;
			case "heading":
				view.root = editable(`h${block.level}`, body, view, "text", block.text);
				break;
			case "quote": {
				view.root = doc.createElement("blockquote");
				view.root.append(editable("p", body, view, "text", block.text));
				break;
			}
			case "callout": {
				view.root = el("aside", { class: "wc-callout", "data-tone": block.tone });
				view.root.append(editable("p", body, view, "text", block.text));
				break;
			}
			case "list": {
				view.lines = linesOf(block.items);
				view.root = listElement(body, view);
				break;
			}
			case "toggle": {
				const details = el("details", { open: "" });
				const summary = editable("summary", body, view, "summary", block.summary);
				// Typing in the summary never folds the Block while it is edited.
				summary.addEventListener("click", (event) => event.preventDefault());
				details.append(summary, editable("p", body, view, "text", block.text));
				view.root = details;
				break;
			}
			case "table": {
				const table = doc.createElement("table");
				const head = block.headerRow ? doc.createElement("thead") : null;
				const rows = doc.createElement("tbody");
				block.rows.forEach((row, rowIndex) => {
					const tr = doc.createElement("tr");
					row.forEach((cell, column) => {
						const header = block.headerRow && rowIndex === 0;
						const element = editable(header ? "th" : "td", body, view, `cell:${rowIndex}:${column}`, cell);
						if (header) element.setAttribute("scope", "col");
						tr.append(element);
					});
					(head && rowIndex === 0 ? head : rows).append(tr);
				});
				if (head) table.append(head);
				table.append(rows);
				view.root = table;
				break;
			}
			case "code": {
				const pre = doc.createElement("pre");
				const code = doc.createElement("code");
				code.setAttribute("contenteditable", "plaintext-only");
				// Browsers without plain-text editing make it plain editing; only its text is read.
				if (code.contentEditable !== "plaintext-only") code.setAttribute("contenteditable", "true");
				code.dataset.wcBlockPart = "code";
				code.textContent = block.code;
				code.setAttribute("role", "textbox");
				code.setAttribute("aria-multiline", "true");
				code.setAttribute("aria-label", blockLabel(body, block));
				if (block.language) code.dataset.language = block.language;
				view.parts.set("code", code);
				pre.append(code);
				view.root = pre;
				break;
			}
			default: {
				// An image, a video, a divider or a Component: what the server rendered, as it is, in a Block
				// people reach with the keyboard.
				view.root = el("div", {
					class: "wc-edit-block",
					tabindex: "0",
					role: "group",
					"aria-label": blockLabel(body, block),
				});
				fill(view, rendered);
			}
		}
		view.root.dataset.wcBlockId = block.id;
		return view;
	}

	/** A wrapper Block's content: what the server rendered, or a label while it shows nothing. */
	function fill(view: View, rendered: Node[] | undefined): void {
		const nodes = (rendered ?? []).filter((node) => node.nodeType !== 3 || node.textContent?.trim());
		if (nodes.length > 0) {
			view.root.replaceChildren(...nodes);
			return;
		}
		const block = view.block;
		let label = word("body.empty.generic");
		if (block.type === "video") label = block.url ? word("body.empty.video") : word("body.empty.noVideo");
		if (block.type === "component") label = word("body.empty.component");
		if (block.type === "divider") {
			view.root.replaceChildren(doc.createElement("hr"));
			return;
		}
		view.root.replaceChildren(el("span", { class: "wc-edit-empty" }, label));
	}

	/** A list's lines as nested lists, each line's text editable. */
	function listElement(body: Body, view: View): HTMLElement {
		const block = view.block as Extract<Block, { type: "list" }>;
		const tag = block.style === "numbered" ? "ol" : "ul";
		const top = doc.createElement(tag);
		const stack: HTMLElement[] = [top];
		const lastItems: HTMLElement[] = [];
		(view.lines ?? []).forEach((line, index) => {
			while (stack.length > line.depth + 1) {
				stack.pop();
				lastItems.pop();
			}
			while (stack.length < line.depth + 1) {
				const parentItem = lastItems[stack.length - 1];
				const nested = doc.createElement(tag);
				(parentItem ?? stack[stack.length - 1])?.append(nested);
				stack.push(nested);
			}
			const item = doc.createElement("li");
			item.append(editable("div", body, view, `item:${index}`, line.text));
			stack[stack.length - 1]?.append(item);
			lastItems[stack.length - 1] = item;
			lastItems.length = stack.length;
		});
		return top;
	}

	/** Draws a Block again (its type, its text changed by the editor itself), keeping its place. */
	function redraw(body: Body, id: string, focus?: { part: string; offset: number | "start" | "end" }): void {
		const before = body.views.get(id);
		const block = body.blocks.find((each) => each.id === id);
		if (!before || !block) return;
		const kept = before.root.classList.contains("wc-edit-block") ? [...before.root.childNodes] : undefined;
		const same = before.block.type === block.type && block.type !== "list" && !isTextBlock(block);
		const view = buildView(body, block, same ? kept : undefined);
		before.root.replaceWith(view.root);
		body.views.set(id, view);
		applyMode(body);
		if (focus) focusPart(body, id, focus.part, focus.offset);
	}

	function focusPart(body: Body, id: string, part: string, offset: number | "start" | "end" = "end"): void {
		const view = body.views.get(id);
		if (!view) return;
		const element = view.parts.get(part) ?? firstPart(view, offset === "end" ? "last" : "first");
		if (element) placeCaret(element, offset);
		else view.root.focus();
	}

	function firstPart(view: View, which: "first" | "last"): HTMLElement | undefined {
		const parts = [...view.parts.values()];
		return which === "first" ? parts[0] : parts[parts.length - 1];
	}

	/** The server's rendering of Blocks that show something it decides (an image, a video, a Component). */
	async function refreshRendered(body: Body, ids: readonly string[], persist = true): Promise<void> {
		// Local changes must be saved first. A remote change is already saved: never write our copy back.
		if (persist && !(await saveNow(body))) return;
		const page = await kit.freshPage();
		if (!page) return;
		const selector = `[data-wc-type="body"][data-wc-item="${CSS.escape(body.item)}"][data-wc-field="${CSS.escape(body.field)}"]`;
		const there = page.querySelector(selector);
		if (!there) return;
		const rendered = renderedBlocks(there);
		for (const id of ids) {
			const view = body.views.get(id);
			if (!view?.root.classList.contains("wc-edit-block")) continue;
			const nodes = (rendered.get(id) ?? []).map((node) => doc.importNode(node, true));
			fill(view, nodes);
			kit.adopt(nodes);
		}
		if (current?.body === body) positionTools();
	}

	// -------------------------------------------------------------------------------------------
	// Changing the Blocks

	/** Reads one editable part back into its Block, as the person typed it. */
	function readPart(view: View, part: string, element: HTMLElement): Block {
		const block = view.block;
		const runs = runsFromElement(element);
		switch (block.type) {
			case "paragraph":
			case "quote":
			case "callout":
				return { ...block, text: runs };
			case "heading":
				return { ...block, text: runs.map((run) => ({ ...run, text: run.text.replace(/\n/g, " ") })) };
			case "list": {
				const index = Number(part.slice("item:".length));
				const lines = (view.lines ?? []).map((line, at) => (at === index ? { ...line, text: runs } : line));
				view.lines = lines;
				return { ...block, items: itemsOf(lines) };
			}
			case "toggle":
				return part === "summary"
					? { ...block, summary: runs.map((run) => ({ ...run, text: run.text.replace(/\n/g, " ") })) }
					: { ...block, text: runs };
			case "table": {
				const [, row = "0", column = "0"] = part.split(":");
				return {
					...block,
					rows: block.rows.map((cells, at) =>
						at === Number(row) ? cells.map((cell, which) => (which === Number(column) ? runs : cell)) : cells,
					),
				};
			}
			case "code":
				return { ...block, code: (element.textContent ?? "").replace(/\r\n?/g, "\n") };
			default:
				return block;
		}
	}

	function setBlock(body: Body, block: Block): void {
		body.blocks = body.blocks.map((each) => (each.id === block.id ? block : each));
		const view = body.views.get(block.id);
		if (view) view.block = block;
		scheduleSave(body);
	}

	/** Puts new Blocks after one (or first, `after` null), drawing them, and saves. */
	function insertBlocks(body: Body, after: string | null, blocks: readonly Block[], focus = true): void {
		const index = after === null ? 0 : body.blocks.findIndex((each) => each.id === after) + 1;
		body.blocks = [...body.blocks.slice(0, index), ...blocks, ...body.blocks.slice(index)];
		const anchor = after === null ? null : (body.views.get(after)?.root ?? null);
		let previous: HTMLElement | null = anchor;
		for (const block of blocks) {
			const view = buildView(body, block);
			body.views.set(block.id, view);
			if (previous) previous.after(view.root);
			else body.region.prepend(view.root);
			previous = view.root;
		}
		applyMode(body);
		scheduleSave(body);
		const rendered = blocks
			.filter((block) => ["image", "video", "component"].includes(block.type))
			.map((block) => block.id);
		if (rendered.length > 0) void refreshRendered(body, rendered);
		const last = blocks[blocks.length - 1];
		if (focus && last) focusPart(body, last.id, firstKey(last), "start");
	}

	function removeBlock(body: Body, id: string): void {
		const index = body.blocks.findIndex((each) => each.id === id);
		const block = body.blocks[index];
		if (!block) return;
		body.blocks = body.blocks.filter((each) => each.id !== id);
		body.views.get(id)?.root.remove();
		body.views.delete(id);
		announce(word("body.removed", { type: typeName(body, block) }));
		if (body.blocks.length === 0) {
			insertBlocks(body, null, [newBlock(PARAGRAPH)]);
			return;
		}
		scheduleSave(body);
		const neighbour = body.blocks[Math.max(0, index - 1)];
		if (neighbour) focusPart(body, neighbour.id, lastKey(neighbour), index > 0 ? "end" : "start");
	}

	function moveBlock(body: Body, id: string, to: number): void {
		const from = body.blocks.findIndex((each) => each.id === id);
		if (from === -1 || to < 0 || to >= body.blocks.length || to === from) return;
		const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
		const offset = active?.isContentEditable ? caretOffset(active) : null;
		body.blocks = moveItem(body.blocks, from, to);
		const view = body.views.get(id);
		const neighbour = body.views.get(body.blocks[to + 1]?.id ?? "");
		if (view) {
			if (neighbour) neighbour.root.before(view.root);
			else body.region.append(view.root);
		}
		if (active && view?.root.contains(active)) {
			if (active.isContentEditable) placeCaret(active, offset ?? "end");
			else active.focus();
		}
		announce(word("body.moved", { to: to + 1, count: body.blocks.length }));
		scheduleSave(body);
		if (current) showTools(current, false);
	}

	/** Turns a Block into another choice (keeping its text when it holds text), or a divider then a paragraph. */
	function replaceWith(body: Body, block: Block, choice: BlockChoice, text: InlineText): void {
		const turned = turnInto({ ...block, ...("text" in block ? { text } : {}) } as Block, choice);
		body.blocks = body.blocks.map((each) => (each.id === block.id ? turned : each));
		redraw(body, block.id);
		announce(word("body.added", { type: word(choice.label) }));
		if (choice.type === "divider") insertBlocks(body, block.id, [newBlock(PARAGRAPH)]);
		else focusPart(body, block.id, firstKey(turned), "start");
		scheduleSave(body);
	}

	function firstKey(block: Block): string {
		if (block.type === "list") return "item:0";
		if (block.type === "toggle") return "summary";
		if (block.type === "table") return "cell:0:0";
		if (block.type === "code") return "code";
		return "text";
	}

	function lastKey(block: Block): string {
		if (block.type === "list") return `item:${linesOf(block.items).length - 1}`;
		if (block.type === "toggle") return "text";
		if (block.type === "table") {
			const rows = block.rows.length - 1;
			return `cell:${rows}:${(block.rows[rows]?.length ?? 1) - 1}`;
		}
		return firstKey(block);
	}

	function typeName(body: Body, block: Block): string {
		if (block.type === "component") return componentName(body, block.component);
		return word(choiceOf(block)?.label ?? "body.choices.paragraph");
	}

	// -------------------------------------------------------------------------------------------
	// Saving: through the page's shared Draft when it is open, else `save`

	function scheduleSave(body: Body): void {
		cancel(body.saveTimer);
		// Put the edit in the shared document before another person's update can arrive. Only the
		// save acknowledgement is debounced: holding a separate snapshot would overwrite their work.
		const shared = sharedOf(body);
		if (
			shared?.ready() &&
			shared.change((draft) => withBody(draft, body.field, body.data.language, outgoing(body) as unknown[]))
		)
			body.pendingSave ??= shared;
		body.saveTimer = later(() => void saveNow(body), 500);
	}

	/** The Blocks as the Draft takes them: what each translates is worked out by the server. */
	function outgoing(body: Body): Block[] {
		return body.blocks.map((block) => {
			const { source: _, ...rest } = block as Block & { source?: unknown };
			return rest as Block;
		});
	}

	async function saveNow(body: Body): Promise<boolean> {
		cancel(body.saveTimer);
		body.saveTimer = 0;
		const blocks = outgoing(body);
		const pending = body.pendingSave;
		body.pendingSave = undefined;
		const shared = pending ?? sharedOf(body);
		if (shared) {
			if (
				!shared.ready() ||
				!shared.change((draft) => withBody(draft, body.field, body.data.language, blocks as unknown[])) ||
				!(await shared.saved())
			) {
				announce(word("body.saveFailed"));
				return false;
			}
		} else {
			const answer = await call("save", {
				item: body.item,
				field: body.field,
				value: blocks,
				language: kit.state().language.code,
			});
			if (!answer.ok) {
				announce(kit.errorText(answer.code));
				return false;
			}
		}
		cancel(body.checkTimer);
		body.checkTimer = later(() => void recheck(body), 1200);
		return true;
	}

	function sharedOf(body: Body): SharedDraft | null {
		listen(body);
		return kit.shared(body.item);
	}

	/** Hears others' changes to the body through the shared Draft, once it is open. */
	function listen(body: Body): void {
		if (body.unlisten) return;
		const shared = kit.shared(body.item);
		if (!shared) {
			later(() => listen(body), 1000);
			return;
		}
		body.unlisten = shared.listen((draft) => remoteChange(body, draft));
	}

	function withBody(draft: unknown, field: string, language: string, blocks: unknown[]): unknown {
		const copy = (draft && typeof draft === "object" ? { ...(draft as Record<string, unknown>) } : {}) as {
			values?: Record<string, unknown>;
		};
		const values = { ...(copy.values ?? {}) };
		const node = { ...((values[field] as Record<string, unknown> | undefined) ?? {}) };
		node[language] = blocks;
		values[field] = node;
		return { ...copy, values };
	}

	/** The body's Blocks in the Draft as its document holds it, in the body's language. */
	function blocksIn(draft: unknown, body: Body): Block[] | null {
		const values = (draft as { values?: Record<string, Record<string, unknown> | undefined> } | null)?.values;
		const list = values?.[body.field]?.[body.data.language];
		return Array.isArray(list) ? (list as Block[]) : null;
	}

	/** Someone else changed the body: show the merged document, keeping the focused part's caret. */
	function remoteChange(body: Body, draft: unknown): void {
		const next = blocksIn(draft, body);
		// Before the shared document opens, a pending HTTP save still owns the local value.
		if (!next || (body.saveTimer && !body.pendingSave)) return;
		const same = (a: Block, b: Block) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));
		const active = doc.activeElement;
		const focused =
			active instanceof HTMLElement && body.region.contains(active)
				? { id: blockIdOf(active), part: active.dataset.wcBlockPart, offset: caretOffset(active) ?? ("end" as const) }
				: null;
		let restoreFocus = false;
		const ids = new Set(next.map((block) => block.id));
		for (const [id, view] of body.views) {
			if (!ids.has(id)) {
				view.root.remove();
				body.views.delete(id);
			}
		}
		const stale: string[] = [];
		let previous: HTMLElement | null = null;
		for (const block of next) {
			let view = body.views.get(block.id);
			if (!view) {
				view = buildView(body, block);
				body.views.set(block.id, view);
				if (view.root.classList.contains("wc-edit-block")) stale.push(block.id);
			} else if (!same(view.block, block)) {
				body.blocks = body.blocks.map((each) => (each.id === block.id ? block : each));
				if (isTextBlock(block) || ["toggle", "table", "code"].includes(block.type)) {
					const fresh = buildView(body, block);
					view.root.replaceWith(fresh.root);
					body.views.set(block.id, fresh);
					view = fresh;
					if (block.id === focused?.id) restoreFocus = true;
				} else {
					view.block = block;
					stale.push(block.id);
				}
			}
			const expected: ChildNode | null = previous ? previous.nextSibling : body.region.firstChild;
			if (expected !== view.root) {
				if (previous) previous.after(view.root);
				else body.region.prepend(view.root);
			}
			previous = view.root;
		}
		body.blocks = next;
		applyMode(body);
		if (restoreFocus && focused?.id && focused.part) focusPart(body, focused.id, focused.part, focused.offset);
		if (stale.length > 0) void refreshRendered(body, stale, false);
	}

	function strip(block: Block): unknown {
		const { source: _, ...rest } = block as Block & { source?: unknown };
		return rest;
	}

	/** Reads the body's problems and Checks again, for the notes beside its Blocks. */
	async function recheck(body: Body): Promise<void> {
		const answer = await call("body/get", { item: body.item, field: body.field, language: kit.state().language.code });
		if (!answer.ok) return;
		const data = answer.data as BodyData;
		body.data = { ...body.data, problems: data.problems, checks: data.checks };
		markNotes(body);
		void kit.refresh();
	}

	/** The problems and Checks of each Block, marked on it; the focused Block's listed beside its tools. */
	function markNotes(body: Body): void {
		body.blocks.forEach((block, index) => {
			const view = body.views.get(block.id);
			if (!view) return;
			const at = `fields.${body.field}[${index}]`;
			const invalid = body.data.problems.some((problem) => problem.at === at || problem.at.startsWith(`${at}.`));
			const checked = body.data.checks.some((check) => check.at === at);
			view.root.toggleAttribute("data-wc-invalid", invalid);
			view.root.toggleAttribute("data-wc-check", checked && !invalid);
		});
		if (current?.body === body) renderNotes();
	}

	function notesOf(place: Place): string[] {
		const index = place.body.blocks.findIndex((each) => each.id === place.id);
		const at = `fields.${place.body.field}[${index}]`;
		const problems = place.body.data.problems
			.filter((problem) => problem.at === at || problem.at.startsWith(`${at}.`))
			.map((problem) => word(`body.problems.${problem.rule ?? "invalid"}`));
		const checks = place.body.data.checks
			.filter((check) => check.at === at)
			.map(
				(check) =>
					`${word("body.checks.warning")} ${word(`body.checks.${check.check}`, { detail: check.detail ?? "" })}`,
			);
		return [...problems, ...checks];
	}

	function renderNotes(): void {
		const found = current ? notesOf(current) : [];
		notes.replaceChildren(...found.map((text) => el("li", {}, text)));
		notes.hidden = found.length === 0 || toolbar.hidden;
		if (!notes.hidden) positionTools();
	}

	// -------------------------------------------------------------------------------------------
	// Typing

	function onInput(body: Body, event: Event): void {
		const element = partOf(event.target);
		const id = blockIdOf(event.target);
		const view = id ? body.views.get(id) : undefined;
		if (!element || !view) return;
		const next = readPart(view, element.dataset.wcBlockPart ?? "", element);
		// A paragraph that becomes ``` or --- turns into code or a divider.
		if (next.type === "paragraph") {
			const whole = next.text.map((run) => run.text).join("");
			const target = allowed(body).find((choice) => choice.id === WHOLE_SHORTCUTS[whole]);
			if (target) {
				replaceWith(body, next, target, []);
				return;
			}
		}
		setBlock(body, next);
	}

	function allowed(body: Body): BlockChoice[] {
		return allowedChoices(body.data.blocksOff);
	}

	function isMac(): boolean {
		return /Mac|iPhone|iPad/.test(kit.win.navigator.platform);
	}

	function onKey(body: Body, event: KeyboardEvent): void {
		if (!on || event.isComposing) return;
		const id = blockIdOf(event.target);
		const view = id ? body.views.get(id) : undefined;
		if (!id || !view) return;
		const index = body.blocks.findIndex((each) => each.id === id);
		const element = partOf(event.target);
		const part = element?.dataset.wcBlockPart ?? "";
		const mod = isMac() ? event.metaKey : event.ctrlKey;
		const block = view.block;

		if (event.altKey && event.key === "F10") {
			event.preventDefault();
			showTools({ body, id }, true);
			return;
		}
		if (event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
			event.preventDefault();
			moveBlock(body, id, index + (event.key === "ArrowUp" ? -1 : 1));
			return;
		}
		// A Block that isn't text (an image, a video, a Component): its form, removing it, moving past it.
		if (!element) {
			if (event.target !== view.root) return;
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				editBlock(body, block, view.root);
			} else if (event.key === "Delete" || event.key === "Backspace") {
				event.preventDefault();
				removeBlock(body, id);
			} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
				event.preventDefault();
				goTo(body, index - 1, "end");
			} else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
				event.preventDefault();
				goTo(body, index + 1, "start");
			}
			return;
		}
		if (mod && !event.altKey) {
			const key = event.key.toLowerCase();
			if (!event.shiftKey && (key === "b" || key === "i" || key === "e")) {
				event.preventDefault();
				format(key === "b" ? "bold" : key === "i" ? "italic" : "code");
				return;
			}
			if (event.shiftKey && key === "x") {
				event.preventDefault();
				format("strikeThrough");
				return;
			}
			if (!event.shiftKey && key === "k") {
				event.preventDefault();
				askLink(element);
				return;
			}
		}
		if (block.type === "list" && mod && (event.key === "]" || event.key === "[")) {
			event.preventDefault();
			nest(body, view, Number(part.slice(5)), event.key === "]");
			return;
		}
		const text = block.type === "paragraph" ? block.text.map((run) => run.text).join("") : "";
		if (event.key === "/" && block.type === "paragraph" && text === "") {
			event.preventDefault();
			openChooser(body, { kind: "slash", id }, element);
			return;
		}
		if (event.key === " " && block.type === "paragraph") {
			const offset = caretOffset(element) ?? 0;
			const target = allowed(body).find((choice) => choice.id === SHORTCUTS[text.slice(0, offset)]);
			if (target) {
				event.preventDefault();
				replaceWith(body, block, target, splitRuns(block.text, offset)[1]);
				return;
			}
		}
		const offset = caretOffset(element);
		const length = runsLength(runsFromElement(element));
		const collapsed = kit.win.getSelection()?.isCollapsed !== false;
		// The arrow keys leave a Block at its first and last line.
		if (!event.shiftKey && !mod && !event.altKey) {
			const parts = [...view.parts.keys()];
			const at = parts.indexOf(part);
			if (
				(event.key === "ArrowUp" && caretOnEdgeLine(element, "first")) ||
				(event.key === "ArrowLeft" && offset === 0)
			) {
				if (at > 0) {
					event.preventDefault();
					focusPart(body, id, parts[at - 1] ?? part, "end");
				} else if (index > 0) {
					event.preventDefault();
					goTo(body, index - 1, "end");
				}
				return;
			}
			if (
				(event.key === "ArrowDown" && caretOnEdgeLine(element, "last")) ||
				(event.key === "ArrowRight" && offset === length)
			) {
				if (at < parts.length - 1) {
					event.preventDefault();
					focusPart(body, id, parts[at + 1] ?? part, "start");
				} else if (index < body.blocks.length - 1) {
					event.preventDefault();
					goTo(body, index + 1, "start");
				}
				return;
			}
		}
		if (block.type === "list" && part.startsWith("item:")) {
			listKeys(body, view, Number(part.slice(5)), element, event);
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			if (block.type === "code") return;
			event.preventDefault();
			if (
				block.type === "paragraph" ||
				block.type === "heading" ||
				block.type === "quote" ||
				block.type === "callout"
			) {
				const [before, after] = splitRuns(block.text, offset ?? block.text.length);
				const kept = { ...block, text: before } as Block;
				setBlock(body, kept);
				redraw(body, id);
				insertBlocks(body, id, [newBlock(PARAGRAPH, after)]);
			} else if (block.type === "toggle" && part === "summary") {
				focusPart(body, id, "text", "start");
			} else {
				insertBlocks(body, id, [newBlock(PARAGRAPH)]);
			}
			return;
		}
		if (
			event.key === "Enter" &&
			event.shiftKey &&
			(block.type === "heading" || part === "summary" || part.startsWith("cell:"))
		) {
			event.preventDefault();
			return;
		}
		if (event.key === "Backspace" && offset === 0 && collapsed && part === firstKey(block)) {
			if (block.type !== "paragraph" && isTextBlock(block)) {
				event.preventDefault();
				replaceWith(body, block, PARAGRAPH, "text" in block ? block.text : []);
				return;
			}
			const previous = body.blocks[index - 1];
			if (block.type === "paragraph" && previous && previous.type !== "toggle" && "text" in previous) {
				event.preventDefault();
				const joinAt = runsLength(previous.text);
				setBlock(body, { ...previous, text: joinRuns(previous.text, block.text) } as Block);
				body.blocks = body.blocks.filter((each) => each.id !== id);
				view.root.remove();
				body.views.delete(id);
				redraw(body, previous.id, { part: "text", offset: joinAt });
				scheduleSave(body);
				return;
			}
			if (block.type === "paragraph" && previous && text === "") {
				event.preventDefault();
				removeBlock(body, id);
			}
		}
	}

	function goTo(body: Body, index: number, offset: "start" | "end"): void {
		const block = body.blocks[index];
		if (!block) return;
		focusPart(body, block.id, offset === "start" ? firstKey(block) : lastKey(block), offset);
	}

	/** Enter, Backspace and nesting in a list's line. */
	function listKeys(body: Body, view: View, line: number, element: HTMLElement, event: KeyboardEvent): void {
		const block = view.block as Extract<Block, { type: "list" }>;
		const lines = view.lines ?? linesOf(block.items);
		const here = lines[line];
		if (!here) return;
		const setLines = (next: Line[], focus: { line: number; offset: number | "start" | "end" }) => {
			view.lines = next;
			setBlock(body, { ...block, items: itemsOf(next) });
			redraw(body, block.id, { part: `item:${focus.line}`, offset: focus.offset });
		};
		const offset = caretOffset(element) ?? runsLength(here.text);
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (runsLength(here.text) === 0) {
				if (here.depth > 0) {
					setLines(
						lines.map((each, at) => (at === line ? { ...each, depth: each.depth - 1 } : each)),
						{ line, offset: "start" },
					);
					return;
				}
				// An empty item at the top leaves the list: a paragraph after it.
				const before = lines.slice(0, line);
				const after = lines.slice(line + 1);
				const paragraph = newBlock(PARAGRAPH);
				const rest: Block[] =
					after.length > 0
						? [
								{
									...block,
									id: newBlockId(),
									items: itemsOf(
										after.map((each) => ({ ...each, depth: Math.max(0, each.depth - (after[0]?.depth ?? 0)) })),
									),
								},
							]
						: [];
				if (before.length === 0) {
					body.blocks = body.blocks.map((each) => (each.id === block.id ? { ...paragraph, id: block.id } : each));
					redraw(body, block.id);
					if (rest.length > 0) insertBlocks(body, block.id, rest, false);
					focusPart(body, block.id, "text", "start");
					scheduleSave(body);
					return;
				}
				view.lines = before;
				setBlock(body, { ...block, items: itemsOf(before) });
				redraw(body, block.id);
				insertBlocks(body, block.id, [paragraph, ...rest], false);
				focusPart(body, paragraph.id, "text", "start");
				return;
			}
			const [first, second] = splitRuns(here.text, offset);
			setLines(
				[
					...lines.slice(0, line),
					{ ...here, text: first },
					{ depth: here.depth, text: second },
					...lines.slice(line + 1),
				],
				{ line: line + 1, offset: "start" },
			);
			return;
		}
		if (event.key === "Backspace" && offset === 0 && kit.win.getSelection()?.isCollapsed !== false) {
			event.preventDefault();
			if (here.depth > 0) {
				setLines(
					lines.map((each, at) => (at === line ? { ...each, depth: each.depth - 1 } : each)),
					{ line, offset: "start" },
				);
			} else if (line > 0) {
				const previous = lines[line - 1] as Line;
				const joinAt = runsLength(previous.text);
				setLines(
					[
						...lines.slice(0, line - 1),
						{ ...previous, text: joinRuns(previous.text, here.text) },
						...lines.slice(line + 1),
					],
					{ line: line - 1, offset: joinAt },
				);
			} else {
				const rest = lines.slice(1);
				const paragraph = newBlock(PARAGRAPH, here.text);
				body.blocks = body.blocks.map((each) => (each.id === block.id ? { ...paragraph, id: block.id } : each));
				redraw(body, block.id, { part: "text", offset: "start" });
				if (rest.length > 0) {
					insertBlocks(
						body,
						block.id,
						[
							{
								...block,
								id: newBlockId(),
								items: itemsOf(
									rest.map((each) => ({ ...each, depth: Math.max(0, each.depth - (rest[0]?.depth ?? 0)) })),
								),
							},
						],
						false,
					);
				}
				scheduleSave(body);
			}
		}
	}

	function nest(body: Body, view: View, line: number, deeper: boolean): void {
		const lines = view.lines ?? [];
		const here = lines[line];
		if (!here) return;
		const depth = deeper ? Math.min(maxDepth(lines, line), here.depth + 1) : Math.max(0, here.depth - 1);
		view.lines = lines.map((each, at) => (at === line ? { ...each, depth } : each));
		setBlock(body, { ...(view.block as Extract<Block, { type: "list" }>), items: itemsOf(view.lines) });
		redraw(body, view.block.id, { part: `item:${line}`, offset: "end" });
	}

	// -------------------------------------------------------------------------------------------
	// Formatting

	/** The selection in the text last focused, kept while a tool takes focus. */
	let lastRange: { element: HTMLElement; range: Range } | null = null;

	doc.addEventListener("selectionchange", () => {
		const selection = kit.win.getSelection();
		if (!selection || selection.rangeCount === 0) return;
		const element = partOf(
			selection.anchorNode instanceof Element ? selection.anchorNode : (selection.anchorNode?.parentElement ?? null),
		);
		if (element?.isContentEditable && element.closest('[data-wc-type="body"]')) {
			lastRange = { element, range: selection.getRangeAt(0).cloneRange() };
		}
	});

	function restoreSelection(): HTMLElement | null {
		if (!lastRange?.element.isConnected) return null;
		lastRange.element.focus();
		const selection = kit.win.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(lastRange.range);
		return lastRange.element;
	}

	function format(command: "bold" | "italic" | "strikeThrough" | "code"): void {
		const element = restoreSelection();
		if (!element) return;
		if (command === "code") {
			const selection = kit.win.getSelection();
			if (!selection || selection.isCollapsed) return;
			const range = selection.getRangeAt(0);
			const inCode = (
				range.commonAncestorContainer instanceof Element
					? range.commonAncestorContainer
					: range.commonAncestorContainer.parentElement
			)?.closest("code");
			const text = range.toString();
			if (inCode && element.contains(inCode)) doc.execCommand("insertText", false, text);
			else doc.execCommand("insertHTML", false, `<code>${escapeHtml(text)}</code>`);
		} else doc.execCommand(command);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	}

	function escapeHtml(text: string): string {
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	/** Asks for a link's address, then links the selection (or adds the address as a link). */
	function askLink(from: HTMLElement): void {
		const input = el("input", {
			class: "text-input",
			type: "url",
			inputmode: "url",
			autocomplete: "off",
			placeholder: "https://",
			"aria-label": word("body.toolbar.link"),
		});
		const problem = el("p", { class: "field-problem", role: "alert" });
		const apply = button({ class: "primary small" }, word("body.linkApply"));
		const form = el(
			"form",
			{ class: "body-form" },
			el("label", { class: "field" }, el("span", { class: "field-label" }, word("body.toolbar.link")), input),
			problem,
			el("div", { class: "actions" }, apply),
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const url = input.value.trim();
			if (!isSafeLink(url)) {
				problem.textContent = word("body.linkInvalid");
				return;
			}
			close(false);
			const element = restoreSelection();
			if (!element) return;
			const selection = kit.win.getSelection();
			if (selection && !selection.isCollapsed) doc.execCommand("createLink", false, url);
			else doc.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
			element.dispatchEvent(new Event("input", { bubbles: true }));
		});
		apply.type = "submit";
		const close = showPanel({ title: word("body.toolbar.link"), from, content: form, focus: input });
	}

	// -------------------------------------------------------------------------------------------
	// The focused Block's tools

	function onFocus(body: Body, event: FocusEvent): void {
		const id = blockIdOf(event.target);
		if (!id) return;
		kit.placeIn({ item: body.item, at: body.field });
		showTools({ body, id }, false);
	}

	doc.addEventListener("focusin", (event) => {
		// Focus leaving the bodies (and their tools) hides the tools.
		const target = event.target;
		if (
			target instanceof Node &&
			([...bodies.keys()].some((region) => region.contains(target)) || kit.root.contains(target))
		)
			return;
		if (event.composedPath().includes(toolbar)) return;
		hideTools();
	});

	function showTools(place: Place, focusTools: boolean): void {
		if (!on) return;
		const view = place.body.views.get(place.id);
		if (!view) return;
		current = place;
		const block = view.block;
		const label = blockLabel(place.body, block);
		toolbar.setAttribute("aria-label", word("body.tools", { block: label }));
		const items: HTMLButtonElement[] = [];
		const index = place.body.blocks.findIndex((each) => each.id === place.id);
		if (phone()) {
			const up = button({ class: "tool", "aria-label": word("body.moveUp"), title: word("body.moveUp") }, icon("up"));
			const down = button(
				{ class: "tool", "aria-label": word("body.moveDown"), title: word("body.moveDown") },
				icon("down"),
			);
			if (index === 0) up.setAttribute("aria-disabled", "true");
			if (index === place.body.blocks.length - 1) down.setAttribute("aria-disabled", "true");
			up.addEventListener("click", () => {
				if (up.getAttribute("aria-disabled") !== "true") moveBlock(place.body, place.id, index - 1);
			});
			down.addEventListener("click", () => {
				if (down.getAttribute("aria-disabled") !== "true") moveBlock(place.body, place.id, index + 1);
			});
			items.push(up, down);
		} else {
			const handle = button(
				{ class: "tool drag", "aria-label": word("body.drag", { block: label }), title: word("body.dragHelp") },
				icon("grip"),
			);
			handle.addEventListener("pointerdown", (event) => startDrag(place, event));
			handle.addEventListener("keydown", (event) => {
				if (event.key === "ArrowUp" || event.key === "ArrowDown") {
					event.preventDefault();
					moveBlock(place.body, place.id, index + (event.key === "ArrowUp" ? -1 : 1));
					handle.focus();
				}
			});
			items.push(handle);
		}
		const add = button(
			{ class: "tool", "aria-label": word("body.addAfter"), title: word("body.addAfter") },
			icon("add"),
		);
		add.addEventListener("click", () => openChooser(place.body, { kind: "after", id: place.id }, add));
		items.push(add);
		if (view.parts.size > 0 && block.type !== "code") {
			for (const [command, name, glyph] of [
				["bold", "body.toolbar.bold", "bold"],
				["italic", "body.toolbar.italic", "italic"],
				["strikeThrough", "body.toolbar.strike", "strike"],
				["code", "body.toolbar.code", "code"],
			] as const) {
				const tool = button({ class: "tool", "aria-label": word(name), title: word(name) }, icon(glyph));
				tool.addEventListener("mousedown", (event) => event.preventDefault());
				tool.addEventListener("click", () => format(command));
				items.push(tool);
			}
			const link = button(
				{ class: "tool", "aria-label": word("body.toolbar.link"), title: word("body.toolbar.link") },
				icon("link"),
			);
			link.addEventListener("mousedown", (event) => event.preventDefault());
			link.addEventListener("click", () => askLink(link));
			items.push(link);
		}
		const more = button(
			{
				class: "tool",
				"aria-label": word("body.actions", { block: label }),
				"aria-haspopup": "menu",
				title: word("body.more"),
			},
			icon("more"),
		);
		more.addEventListener("click", () => openBlockMenu(place, more));
		items.push(more);
		items.forEach((item, at) => {
			item.setAttribute("tabindex", at === 0 ? "0" : "-1");
		});
		toolbar.replaceChildren(...items);
		toolbar.hidden = false;
		positionTools();
		renderNotes();
		if (focusTools) items[0]?.focus();
	}

	toolbar.addEventListener("keydown", (event) => {
		const items = [...toolbar.querySelectorAll<HTMLButtonElement>("button")];
		const at = items.indexOf(event.target as HTMLButtonElement);
		if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "Home" || event.key === "End") {
			event.preventDefault();
			const next =
				event.key === "Home"
					? 0
					: event.key === "End"
						? items.length - 1
						: (at + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
			items.forEach((item, index) => {
				item.setAttribute("tabindex", index === next ? "0" : "-1");
			});
			items[next]?.focus();
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			if (current)
				focusPart(
					current.body,
					current.id,
					firstKey(current.body.views.get(current.id)?.block ?? newBlock(PARAGRAPH)),
					"end",
				);
		}
	});

	function hideTools(): void {
		current = null;
		toolbar.hidden = true;
		notes.hidden = true;
		kit.placeIn(null);
	}

	function rectOf(view: View): DOMRect {
		return view.root.getBoundingClientRect();
	}

	function positionTools(): void {
		if (!current || toolbar.hidden) return;
		const view = current.body.views.get(current.id);
		if (!view?.root.isConnected) {
			hideTools();
			return;
		}
		const rect = rectOf(view);
		kit.place(toolbar, rect, 6, "above");
		if (!notes.hidden) {
			const box = toolbar.getBoundingClientRect();
			kit.place(notes, new DOMRect(box.left, box.top, box.width, box.height), 4, "above");
		}
	}

	kit.win.addEventListener("scroll", () => positionTools(), { passive: true });
	kit.win.addEventListener("resize", () => positionTools());

	// -------------------------------------------------------------------------------------------
	// Dragging a Block (desktop); phones move Blocks with Move up and Move down

	function startDrag(place: Place, event: PointerEvent): void {
		if (event.button !== 0) return;
		event.preventDefault();
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		let target = place.body.blocks.findIndex((each) => each.id === place.id);
		const move = (moved: PointerEvent) => {
			const rects = place.body.blocks.map((block) => place.body.views.get(block.id)?.root.getBoundingClientRect());
			let index = rects.findIndex((rect) => rect && moved.clientY < rect.top + rect.height / 2);
			if (index === -1) index = rects.length;
			const from = place.body.blocks.findIndex((each) => each.id === place.id);
			target = index > from ? index - 1 : index;
			const at = rects[Math.min(index, rects.length - 1)];
			if (at) {
				const y = index >= rects.length ? at.bottom : at.top;
				dropLine.hidden = false;
				dropLine.style.top = `${y - 1}px`;
				dropLine.style.left = `${at.left}px`;
				dropLine.style.width = `${at.width}px`;
			}
		};
		const up = () => {
			handle.removeEventListener("pointermove", move);
			dropLine.hidden = true;
			moveBlock(place.body, place.id, target);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up, { once: true });
		handle.addEventListener(
			"pointercancel",
			() => {
				handle.removeEventListener("pointermove", move);
				dropLine.hidden = true;
			},
			{ once: true },
		);
	}

	// -------------------------------------------------------------------------------------------
	// Popups: a panel beside what opened it, or a bottom sheet on a phone

	function showPanel(options: {
		title: string;
		from: HTMLElement | null;
		content: HTMLElement;
		focus?: HTMLElement | null;
	}): (focusBack: boolean) => void {
		open?.close(false);
		if (phone()) {
			const sheet = kit.sheet({ title: options.title, from: options.from, content: options.content });
			later(
				() => (options.focus ?? options.content.querySelector<HTMLElement>("input, select, textarea, button"))?.focus(),
				0,
			);
			const close = (focusBack: boolean) => {
				if (open === entry) open = null;
				if (!focusBack) options.from = null;
				sheet.close();
			};
			const entry = { close };
			open = entry;
			return close;
		}
		const panel = el(
			"div",
			{ class: "popup body-panel", role: "dialog", "aria-label": options.title },
			el("div", { class: "panel-head" }, el("h2", { class: "panel-title" }, options.title)),
			options.content,
		);
		panel.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close(true);
			}
		});
		kit.layer.append(panel);
		const rect = options.from?.getBoundingClientRect() ?? new DOMRect(16, 80, 0, 0);
		kit.place(panel, rect, 6, "below");
		const close = (focusBack: boolean) => {
			if (open === entry) open = null;
			panel.remove();
			if (focusBack && options.from?.isConnected) options.from.focus();
		};
		const entry = { close };
		open = entry;
		later(
			() => (options.focus ?? options.content.querySelector<HTMLElement>("input, select, textarea, button"))?.focus(),
			0,
		);
		return close;
	}

	/** A menu of actions beside the button that opened it (a sheet of rows on a phone). */
	function showMenu(
		from: HTMLElement,
		title: string,
		actions: { label: string; run(): void; disabled?: boolean; danger?: boolean }[],
	): void {
		const items = actions.map((action) => {
			const item = button(
				{
					role: "menuitem",
					tabindex: "-1",
					class: phone() ? "sheet-row" : "menu-row",
					...(action.disabled ? { "aria-disabled": "true" } : {}),
				},
				el("span", { class: phone() ? "sheet-row-text" : "menu-title" }, action.label),
			);
			if (action.danger) item.classList.add("danger-item");
			item.addEventListener("click", () => {
				if (action.disabled) return;
				close(false);
				action.run();
			});
			return item;
		});
		const menu = el(
			"div",
			{ class: phone() ? "sheet-rows" : "menu body-menu", role: "menu", "aria-label": title },
			...items,
		);
		menu.addEventListener("keydown", (event) => {
			const at = items.indexOf(event.target as HTMLButtonElement);
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
			} else if (event.key === "Home" || event.key === "End") {
				event.preventDefault();
				items[event.key === "Home" ? 0 : items.length - 1]?.focus();
			} else if (event.key === "Tab") {
				close(false);
			}
		});
		const close = showPanel({ title, from, content: menu, focus: items[0] ?? null });
	}

	function openBlockMenu(place: Place, from: HTMLElement): void {
		const { body, id } = place;
		const view = body.views.get(id);
		if (!view) return;
		const block = view.block;
		const index = body.blocks.findIndex((each) => each.id === id);
		const actions: { label: string; run(): void; disabled?: boolean; danger?: boolean }[] = [];
		if (isTextBlock(block)) {
			for (const choice of allowed(body).filter(
				(each) => isTextBlock(newBlock(each)) && each.id !== choiceOf(block)?.id,
			)) {
				actions.push({
					label: `${word("body.turnInto")}: ${word(choice.label)}`,
					run: () => replaceWith(body, block, choice, "text" in block ? block.text : []),
				});
			}
		}
		if (["video", "component", "image", "code", "callout", "table"].includes(block.type)) {
			actions.push({ label: editLabel(body, block), run: () => editBlock(body, block, from) });
		}
		actions.push(
			{ label: word("body.moveUp"), run: () => moveBlock(body, id, index - 1), disabled: index === 0 },
			{
				label: word("body.moveDown"),
				run: () => moveBlock(body, id, index + 1),
				disabled: index === body.blocks.length - 1,
			},
			{ label: word("body.remove"), run: () => removeBlock(body, id), danger: true },
		);
		showMenu(from, word("body.actions", { block: blockLabel(body, block) }), actions);
	}

	function editLabel(body: Body, block: Block): string {
		if (block.type === "component") return word("body.components.edit", { name: componentName(body, block.component) });
		if (block.type === "image") return word("body.editImage");
		if (block.type === "video") return word("body.editVideo");
		if (block.type === "code") return word("body.code.language");
		if (block.type === "callout") return word("body.editCallout");
		return word("body.editTable");
	}

	/** Opens what changes a Block that isn't typed in: its form, or the image popover. */
	function editBlock(body: Body, block: Block, from: HTMLElement): void {
		if (block.type === "image") {
			const region = body.views.get(block.id)?.root.querySelector<HTMLElement>('[data-wc-type="media"]');
			const decorative = el("input", { type: "checkbox" });
			decorative.checked = block.decorative === true;
			const change = button({ class: "secondary small" }, word("body.editImage"));
			change.addEventListener("click", () => {
				close(false);
				if (region && kit.openImage) kit.openImage(region);
			});
			const form = el(
				"form",
				{ class: "body-form" },
				field(word("body.image.decorative"), decorative),
				change,
				formActions(word("body.done"), () => close(true)),
			);
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				close(true);
				setBlock(body, { ...block, decorative: decorative.checked });
				void refreshRendered(body, [block.id]);
			});
			const close = showPanel({ title: word("body.editImage"), from, content: form, focus: decorative });
			return;
		}
		if (block.type === "component") {
			const component = body.data.components.find((each) => each.id === block.component);
			if (component) propsForm(body, component, from, { block });
			return;
		}
		if (block.type === "video") videoForm(body, block, from);
		else if (block.type === "code") codeForm(body, block, from);
		else if (block.type === "callout") calloutForm(body, block, from);
		else if (block.type === "table") tableForm(body, block, from);
	}

	function field(labelText: string, control: HTMLElement, help?: string): HTMLElement {
		const id = `wc-body-${newBlockId()}`;
		control.id = id;
		const parts: (Node | string)[] = [el("label", { class: "field-label", for: id }, labelText), control];
		if (help) {
			const helpId = `${id}-help`;
			control.setAttribute("aria-describedby", helpId);
			parts.push(el("p", { class: "help", id: helpId }, help));
		}
		return el("div", { class: "field" }, ...parts);
	}

	function formActions(submit: string, onCancel: () => void): HTMLElement {
		const cancelButton = button({ class: "secondary small" }, word("body.cancel"));
		cancelButton.addEventListener("click", onCancel);
		const save = button({ class: "primary small", type: "submit" }, submit);
		return el("div", { class: "actions" }, cancelButton, save);
	}

	function videoForm(body: Body, block: Extract<Block, { type: "video" }>, from: HTMLElement): void {
		const url = el("input", {
			class: "text-input",
			type: "url",
			inputmode: "url",
			autocomplete: "off",
			placeholder: "https://",
		});
		url.value = block.url;
		const title = el("input", { class: "text-input", autocomplete: "off", maxlength: "300" });
		title.value = block.title;
		const form = el(
			"form",
			{ class: "body-form" },
			field(word("body.video.address"), url, word("body.video.addressHelp")),
			field(word("body.video.title"), title, word("body.video.titleHelp")),
			formActions(word("body.done"), () => close(true)),
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			close(true);
			const found = videoAt(url.value.trim());
			setBlock(body, { ...block, url: found?.watchUrl ?? url.value.trim(), title: title.value.trim() });
			void refreshRendered(body, [block.id]);
		});
		const close = showPanel({ title: word("body.editVideo"), from, content: form, focus: url });
	}

	function codeForm(body: Body, block: Extract<Block, { type: "code" }>, from: HTMLElement): void {
		const language = el("input", { class: "text-input", autocomplete: "off", maxlength: "32", spellcheck: "false" });
		language.value = block.language ?? "";
		const form = el(
			"form",
			{ class: "body-form" },
			field(word("body.code.language"), language),
			formActions(word("body.done"), () => close(true)),
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			close(true);
			setBlock(body, { ...block, language: language.value.trim().toLowerCase() || null });
		});
		const close = showPanel({ title: word("body.code.language"), from, content: form, focus: language });
	}

	function calloutForm(body: Body, block: Extract<Block, { type: "callout" }>, from: HTMLElement): void {
		const tone = el("select", { class: "text-input" });
		for (const each of CALLOUT_TONES) {
			const option = el("option", { value: each }, word(`body.callout.tones.${each}`));
			if (each === block.tone) option.selected = true;
			tone.append(option);
		}
		const form = el(
			"form",
			{ class: "body-form" },
			field(word("body.callout.tone", { block: blockLabel(body, block) }), tone),
			formActions(word("body.done"), () => close(true)),
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			close(true);
			const next = { ...block, tone: tone.value as CalloutTone };
			setBlock(body, next);
			redraw(body, block.id);
		});
		const close = showPanel({ title: word("body.editCallout"), from, content: form, focus: tone });
	}

	function tableForm(body: Body, block: Extract<Block, { type: "table" }>, from: HTMLElement): void {
		const columns = Math.max(1, ...block.rows.map((row) => row.length));
		const change = (next: Extract<Block, { type: "table" }>) => {
			close(true);
			setBlock(body, next);
			redraw(body, block.id);
		};
		const header = el("input", { type: "checkbox" });
		header.checked = block.headerRow;
		header.addEventListener("change", () => change({ ...block, headerRow: header.checked }));
		const actions: [string, () => void, boolean][] = [
			[
				word("body.table.addRow"),
				() => change({ ...block, rows: [...block.rows, Array.from({ length: columns }, () => [])] }),
				block.rows.length < 500,
			],
			[
				word("body.table.addColumn"),
				() => change({ ...block, rows: block.rows.map((row) => [...row, []]) }),
				columns < 20,
			],
			[word("body.table.removeRow"), () => change({ ...block, rows: block.rows.slice(0, -1) }), block.rows.length > 1],
			[
				word("body.table.removeColumn"),
				() => change({ ...block, rows: block.rows.map((row) => row.slice(0, -1)) }),
				columns > 1,
			],
		];
		const form = el(
			"div",
			{ class: "body-form" },
			el("label", { class: "check-field" }, header, word("body.table.headerRow")),
			...actions.map(([label, run, enabled]) => {
				const item = button({ class: "secondary small", ...(enabled ? {} : { disabled: "" }) }, label);
				item.addEventListener("click", run);
				return item;
			}),
		);
		const close = showPanel({ title: word("body.editTable"), from, content: form, focus: header });
	}

	// -------------------------------------------------------------------------------------------
	// The Block chooser: `/` in an empty paragraph, or Add Block

	type Opening = { kind: "slash"; id: string } | { kind: "after"; id: string };

	function openChooser(body: Body, opening: Opening, from: HTMLElement): void {
		const listId = `wc-body-list-${newBlockId()}`;
		const input = el("input", {
			class: "text-input",
			role: "combobox",
			"aria-expanded": "true",
			"aria-autocomplete": "list",
			"aria-controls": listId,
			"aria-label": word("body.menu.label"),
			placeholder: word("body.menu.placeholder"),
			autocomplete: "off",
		});
		const list = el("div", {
			class: "chooser-list",
			role: "listbox",
			id: listId,
			"aria-label": word("body.menu.label"),
		});
		const none = el("p", { class: "help", role: "status" });
		type Option = { id: string; label: string; group: "blocks" | "components"; run(): void };
		const options: Option[] = [
			...allowed(body).map((choice) => ({
				id: choice.id,
				label: word(choice.label),
				group: "blocks" as const,
				keywords: choice.keywords,
				type: choice.type,
				run: () => choose(choice),
			})),
			...body.data.components.map((component) => ({
				id: `component-${component.id}`,
				label: component.name,
				group: "components" as const,
				keywords: `component ${component.name}`,
				type: "component",
				run: () => {
					finish(false);
					propsForm(body, component, from, { opening });
				},
			})),
		] as (Option & { keywords: string; type: string })[];
		let active = 0;
		let shown: Option[] = [];
		const render = () => {
			const query = input.value;
			const filtered = (options as (Option & { keywords: string; type: string })[]).filter((option) =>
				matches({ keywords: option.keywords, type: option.type as never }, option.label, query),
			);
			// What starts with the words typed comes first, its group with it.
			const words = query.trim().toLowerCase();
			const starts = (option: Option) => words !== "" && option.label.toLowerCase().startsWith(words);
			const ranked = [...filtered.filter(starts), ...filtered.filter((option) => !starts(option))];
			const order = [...new Set(ranked.map((option) => option.group))];
			shown = order.flatMap((group) => ranked.filter((option) => option.group === group));
			active = Math.min(active, Math.max(0, shown.length - 1));
			const groups: Node[] = [];
			for (const group of order) {
				const inGroup = shown.filter((option) => option.group === group);
				if (inGroup.length === 0) continue;
				const groupId = `${listId}-${group}`;
				groups.push(
					el(
						"div",
						{ role: "group", "aria-labelledby": groupId },
						el(
							"div",
							{ class: "chooser-group", id: groupId, role: "presentation" },
							word(group === "blocks" ? "body.menu.blocks" : "body.components.group"),
						),
						...inGroup.map((option) => {
							const element = el(
								"div",
								{
									role: "option",
									id: `${listId}-${option.id}`,
									class: "chooser-option",
									"aria-selected": String(shown[active] === option),
								},
								option.label,
							);
							element.addEventListener("mousedown", (event) => event.preventDefault());
							element.addEventListener("click", () => option.run());
							return element;
						}),
					),
				);
			}
			list.replaceChildren(...groups);
			const current = shown[active];
			if (current) input.setAttribute("aria-activedescendant", `${listId}-${current.id}`);
			else input.removeAttribute("aria-activedescendant");
			none.textContent = shown.length === 0 ? word("body.menu.none") : "";
			list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
		};
		input.addEventListener("input", () => {
			active = 0;
			render();
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (shown.length > 0) active = (active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
				render();
			} else if (event.key === "Home" || event.key === "End") {
				event.preventDefault();
				active = event.key === "Home" ? 0 : Math.max(0, shown.length - 1);
				render();
			} else if (event.key === "Enter") {
				event.preventDefault();
				shown[active]?.run();
			} else if (event.key === "Escape" || (event.key === "Backspace" && input.value === "")) {
				event.preventDefault();
				event.stopPropagation();
				finish(true);
			} else if (event.key === "Tab") {
				finish(false);
			}
		});
		const content = el("div", { class: "chooser" }, input, list, none);
		const close = showPanel({ title: word("body.menu.label"), from, content, focus: input });
		render();

		const choose = (choice: BlockChoice) => {
			finish(false);
			const anchor = body.blocks.find((each) => each.id === opening.id);
			const empty = anchor?.type === "paragraph" && runsLength(anchor.text) === 0;
			if (anchor && (opening.kind === "slash" || empty)) {
				replaceWith(body, anchor, choice, []);
				if (choice.type === "image" || choice.type === "video") editAfterInsert(body, anchor.id);
				return;
			}
			const block = newBlock(choice);
			const after = choice.type === "divider" ? [block, newBlock(PARAGRAPH)] : [block];
			insertBlocks(body, opening.id, after);
			announce(word("body.added", { type: word(choice.label) }));
			if (choice.type === "image" || choice.type === "video") editAfterInsert(body, block.id);
		};
		function finish(restore: boolean) {
			close(false);
			const anchor = body.blocks.find((each) => each.id === opening.id);
			if (!restore || !anchor) return;
			// Escape keeps the `/` that opened it.
			if (opening.kind === "slash" && anchor.type === "paragraph") {
				const element = body.views.get(anchor.id)?.parts.get("text");
				if (element) {
					element.textContent = "/";
					setBlock(body, { ...anchor, text: [{ text: "/" }] });
				}
			}
			focusPart(body, anchor.id, firstKey(anchor), "end");
		}
	}

	/** A new image or video Block opens what fills it at once: the Media library, or the video's form. */
	function editAfterInsert(body: Body, id: string): void {
		later(async () => {
			const view = body.views.get(id);
			if (!view) return;
			if (view.block.type === "video") {
				videoForm(body, view.block, view.root);
				return;
			}
			if (view.block.type !== "image") return;
			const chosen = await kit.pickImage({ title: word("body.choices.image"), current: null, from: view.root });
			if (!chosen) return;
			setBlock(body, { ...view.block, media: chosen.id });
			void refreshRendered(body, [id]);
		}, 0);
	}

	// -------------------------------------------------------------------------------------------
	// A Component's Props, filled before it goes in (and changed later)

	function propsForm(
		body: Body,
		component: BodyComponentChoice,
		from: HTMLElement,
		target: { opening: Opening } | { block: Extract<Block, { type: "component" }> },
	): void {
		const given =
			"block" in target
				? new Map(target.block.props.map((prop) => [prop.name, prop.value]))
				: new Map<string, string>();
		const readers: { prop: PropField; read(): string | null }[] = [];
		const fields = component.props.map((prop) => {
			const value = given.get(prop.key) ?? ("block" in target ? "" : propDefaultText(prop));
			const label = `${prop.label}${propNeeded(prop) ? ` (${word("body.components.required")})` : ""}`;
			if (prop.type === "boolean") {
				const box = el("input", { type: "checkbox" });
				box.checked = value === "" ? !("block" in target) && prop.default === true : value !== "false";
				if ("block" in target && given.has(prop.key)) box.checked = value === "" || value === "true";
				readers.push({ prop, read: () => (box.checked ? "true" : "false") });
				return el("label", { class: "check-field" }, box, prop.label);
			}
			if (prop.type === "select" && prop.options) {
				const select = el("select", { class: "text-input", ...(prop.multiple ? { multiple: "" } : {}) });
				if (!prop.multiple) select.append(el("option", { value: "" }, "—"));
				const chosen = new Set(value.split(",").map((each) => each.trim()));
				for (const option of prop.options) {
					const element = el("option", { value: option.value }, option.label);
					if (chosen.has(option.value)) element.selected = true;
					select.append(element);
				}
				readers.push({
					prop,
					read: () =>
						[...select.selectedOptions]
							.map((option) => option.value)
							.filter(Boolean)
							.join(","),
				});
				return field(label, select, prop.help || undefined);
			}
			if (prop.type === "media") {
				let media = value.startsWith("media:") ? value : "";
				const name = el(
					"span",
					{ class: "media-name" },
					media ? word("body.components.imageChosen") : word("body.components.noImage"),
				);
				const choose = button({ class: "secondary small" }, word("body.components.chooseImage"));
				choose.addEventListener("click", async () => {
					const chosen = await kit.pickImage({ title: prop.label, current: media.slice(6) || null, from: choose });
					if (!chosen) return;
					media = `media:${chosen.id}`;
					name.textContent = chosen.title || chosen.fileName;
				});
				readers.push({ prop, read: () => media });
				return el(
					"div",
					{ class: "field" },
					el("span", { class: "field-label" }, label),
					el("div", { class: "media-row" }, choose, name),
				);
			}
			const multiline = prop.type === "richText" || prop.type === "group" || prop.type === "repeater";
			const input = multiline
				? el("textarea", { class: "text-input", rows: "4" })
				: el("input", {
						class: "text-input",
						autocomplete: "off",
						type:
							prop.type === "number" ? "text" : prop.type === "email" ? "email" : prop.type === "link" ? "url" : "text",
						...(prop.type === "number" ? { inputmode: "decimal" } : {}),
					});
			input.value = value;
			readers.push({ prop, read: () => input.value });
			const help =
				prop.type === "group" || prop.type === "repeater" ? word("body.components.json") : prop.help || undefined;
			return field(label, input, help);
		});
		const problem = el("p", { class: "field-problem", role: "alert" });
		const submitLabel = "block" in target ? word("body.components.save") : word("body.components.insert");
		const form = el(
			"form",
			{ class: "body-form props-form" },
			...(fields.length === 0 ? [el("p", { class: "help" }, word("body.components.none"))] : fields),
			problem,
			formActions(submitLabel, () => close(true)),
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const props: { name: string; value: string }[] = [];
			for (const { prop, read } of readers) {
				const value = (read() ?? "").trim();
				if (value === "" && propNeeded(prop)) {
					problem.textContent = word("body.components.missing", { prop: prop.label });
					return;
				}
				if (value !== "") props.push({ name: prop.key, value });
			}
			close(false);
			if ("block" in target) {
				setBlock(body, { ...target.block, props });
				void refreshRendered(body, [target.block.id]);
				body.views.get(target.block.id)?.root.focus();
				return;
			}
			const block = newComponentBlock(component.id, props);
			const anchor = body.blocks.find((each) => each.id === target.opening.id);
			const empty = anchor?.type === "paragraph" && runsLength(anchor.text) === 0;
			if (anchor && empty) {
				// The empty paragraph `/` opened from becomes the Component.
				body.blocks = body.blocks.map((each) => (each.id === anchor.id ? { ...block, id: anchor.id } : each));
				redraw(body, anchor.id);
				body.views.get(anchor.id)?.root.focus();
				void refreshRendered(body, [anchor.id]);
			} else {
				insertBlocks(body, target.opening.id, [block], false);
				body.views.get(block.id)?.root.focus();
			}
			announce(word("body.added", { type: component.name }));
		});
		const close = showPanel({
			title: word("body.components.title", { name: component.name }),
			from,
			content: form,
		});
	}

	// -------------------------------------------------------------------------------------------
	// Pasting

	async function onPaste(body: Body, event: ClipboardEvent): Promise<void> {
		const element = partOf(event.target);
		const id = blockIdOf(event.target);
		if (!element || !id || !event.clipboardData || !on) return;
		const view = body.views.get(id);
		if (!view || view.block.type === "code") return;
		const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
		const html = event.clipboardData.getData("text/html");
		const text = event.clipboardData.getData("text/plain");
		const selection = kit.win.getSelection();
		const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
		event.preventDefault();
		if (files.length > 0) {
			if (body.data.blocksOff.includes("image")) return;
			announce(word("body.paste.uploading"));
			const added: Block[] = [];
			for (const file of files) {
				const answer = await kit.upload(file);
				if (!answer.ok) {
					announce(kit.errorText(answer.code));
					continue;
				}
				const media = (answer.data as { media?: { id?: string } }).media?.id;
				if (media) added.push({ id: newBlockId(), type: "image", media });
			}
			if (added.length > 0 && element.isConnected && body.views.has(id)) {
				insertBlocks(body, id, added, false);
				void refreshRendered(
					body,
					added.map((block) => block.id),
				);
				announce(word("body.paste.added", { count: added.length }));
			}
			return;
		}
		if (!html && !text) return;
		const answer = await call("body/paste", {
			item: body.item,
			field: body.field,
			language: kit.state().language.code,
			...(html ? { html } : {}),
			text,
		});
		if (!answer.ok) {
			announce(word("body.paste.failed"));
			return;
		}
		if (!element.isConnected || !body.views.has(id)) return;
		const blocks = (answer.data as { blocks: Block[] }).blocks;
		const [only] = blocks;
		// Conversion is asynchronous: the person may have selected another Block while waiting.
		// One paragraph goes into the original range, with its formatting and links kept.
		if (
			blocks.length === 1 &&
			only?.type === "paragraph" &&
			view.parts.size > 0 &&
			range &&
			element.contains(range.commonAncestorContainer)
		) {
			element.focus();
			selection?.removeAllRanges();
			selection?.addRange(range);
			doc.execCommand("insertHTML", false, renderRuns(only.text));
			element.dispatchEvent(new Event("input", { bubbles: true }));
			return;
		}
		if (blocks.length === 0) return;
		const empty = view.block.type === "paragraph" && runsLength(view.block.text) === 0;
		if (empty) {
			const [first, ...rest] = blocks as [Block, ...Block[]];
			blocks[0] = { ...first, id };
			body.blocks = body.blocks.map((each) => (each.id === id ? { ...first, id } : each));
			redraw(body, id);
			if (rest.length > 0) insertBlocks(body, id, rest, true);
			else focusPart(body, id, lastKey(first), "end");
			scheduleSave(body);
		} else insertBlocks(body, id, blocks);
		const waiting = blocks
			.filter((block) => ["image", "video", "component"].includes(block.type))
			.map((block) => block.id);
		if (waiting.length > 0) void refreshRendered(body, waiting);
		announce(word("body.paste.added", { count: blocks.length }));
	}

	function renderRuns(runs: readonly Run[]): string {
		return runsToHtml([...runs]);
	}

	// -------------------------------------------------------------------------------------------
	// Edit and Preview

	function applyMode(body: Body): void {
		for (const view of body.views.values()) {
			for (const part of view.parts.values()) {
				if (part.dataset.wcBlockPart === "code")
					part.setAttribute(
						"contenteditable",
						on ? (part.contentEditable === "true" ? "true" : "plaintext-only") : "false",
					);
				else part.setAttribute("contenteditable", on ? "true" : "false");
			}
			if (view.root.classList.contains("wc-edit-block")) {
				if (on) view.root.setAttribute("tabindex", "0");
				else view.root.removeAttribute("tabindex");
			}
		}
	}

	return {
		setUp,
		mode(next) {
			on = next;
			for (const body of bodies.values()) applyMode(body);
			if (!on) {
				hideTools();
				open?.close(false);
			}
		},
		targets(): PresenceTarget[] {
			return [...bodies.values()].map((body) => ({
				item: body.item,
				at: body.field,
				rect: () => (body.region.isConnected ? body.region.getBoundingClientRect() : null),
			}));
		},
		close() {
			open?.close(false);
		},
	};
}
