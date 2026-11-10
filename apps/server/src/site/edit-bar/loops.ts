import type { BarKit, LoopTools, MediaChoice, PresenceTarget } from "./kit.ts";

/**
 * Loop items in Edit mode (GLOSSARY.md › Loop item). The page marks each Loop of the Site and its
 * items with comments (`<!--wc-loop …-->`, `<!--wc-item <key>-->`), so nothing of its layout changes.
 * A Loop's own items get tools when the pointer is over one or focus is in one (Alt+F10 reaches them
 * from the keyboard): edit the item's Fields in a form, move it earlier or later, duplicate it, remove
 * it (with Undo for a while) and add an item after it; an empty Loop gets an "Add item" button. Each
 * change is saved to the Loop's Draft and announced, and the Loop is shown again as the server renders
 * it. A query Loop's items are Entries: each gets an "Edit this Entry" link to its own page.
 *
 * Like the editing bar, this is one self-contained function served as source text (`assets.ts`).
 */
export function loopTools(kit: BarKit): LoopTools {
	const { win, doc, el, button, icon, word, call, later, cancel } = kit;
	type Item = { key: string; start: Comment; end: Comment; index: number; count: number };
	type Shown = {
		id: string;
		source: "items" | "query";
		name: string;
		start: Comment;
		end: Comment;
		/** Which of the Loop's appearances on the page it is (a Loop can show twice). */
		n: number;
		items: Item[];
	};
	type Field = {
		key: string;
		label: string;
		type: string;
		translatable?: boolean;
		multiple?: boolean;
		mode?: string;
		options?: { value: string; label: string }[];
		fields?: Field[];
	};
	type Values = Record<string, unknown>;
	type Problem = { at: string; rule?: string; message?: string };
	type EntryLink = { id: string; title: string; href: string; page: boolean };

	let loops: Shown[] = [];
	let on = false;
	/** The item whose tools show, and what showed them. */
	let current: { loop: Shown; item: Item } | null = null;
	let hideTimer = 0;
	const links = new Map<string, EntryLink>();
	const toolbar = el("div", { class: "loop-toolbar", role: "toolbar", "aria-orientation": "horizontal", hidden: "" });
	const outline = el("div", { class: "loop-outline", "aria-hidden": "true", hidden: "" });
	const label = el("div", { class: "loop-tag", "aria-hidden": "true", hidden: "" });
	const adds = new Map<string, HTMLButtonElement>();
	const notice = el("div", { class: "loop-notice", role: "status", hidden: "" });
	let noticeTimer = 0;
	let form: { close(): void } | null = null;
	kit.layer.append(outline, label, toolbar, notice);

	// -------------------------------------------------------------------------------------------
	// Finding the Loops on the page

	/** The words of a mark, read back as the page wrote them (each percent-encoded). */
	function words(comment: Comment, kind: string): string[] | null {
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

	function scan(): void {
		const found: Shown[] = [];
		const open: Shown[] = [];
		let item: Partial<Item> | null = null;
		const seen = new Map<string, number>();
		const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const comment = node as Comment;
			const loop = words(comment, "wc-loop");
			const opened = open[open.length - 1];
			if (loop) {
				const [id = "", source = "", name = ""] = loop;
				const n = seen.get(id) ?? 0;
				seen.set(id, n + 1);
				open.push({
					id: id.replace(/^loop:/, ""),
					source: source === "items" ? "items" : "query",
					name,
					start: comment,
					end: comment,
					n,
					items: [],
				});
			} else if (comment.data === "/wc-loop" && opened) {
				opened.end = comment;
				open.pop();
				found.push(opened);
			} else if (opened && words(comment, "wc-item")) {
				item = { key: words(comment, "wc-item")?.[0] ?? "", start: comment };
			} else if (opened && comment.data === "/wc-item" && item?.start) {
				opened.items.push({
					key: item.key ?? "",
					start: item.start,
					end: comment,
					index: opened.items.length,
					count: 0,
				});
				item = null;
			}
		}
		for (const loop of found) for (const each of loop.items) each.count = loop.items.length;
		loops = found;
		for (const loop of loops) for (const each of loop.items) prepare(each);
		renderAdds();
		void loadLinks();
		if (current) {
			const again = find(current.loop.id, current.item.key);
			current = again ?? null;
			if (current) showTools(current.loop, current.item, false);
			else hideTools();
		}
	}

	/** The nodes between an item's marks. */
	function nodesOf(item: Pick<Item, "start" | "end">): Node[] {
		const nodes: Node[] = [];
		for (let node = item.start.nextSibling; node && node !== item.end; node = node.nextSibling) nodes.push(node);
		return nodes;
	}

	function elementsOf(item: Item): HTMLElement[] {
		return nodesOf(item).filter((node): node is HTMLElement => node instanceof HTMLElement);
	}

	function rectOf(range: Pick<Item, "start" | "end">): DOMRect {
		const span = doc.createRange();
		span.setStartAfter(range.start);
		span.setEndBefore(range.end);
		return span.getBoundingClientRect();
	}

	function find(loopId: string, key: string): { loop: Shown; item: Item } | null {
		for (const loop of loops) {
			const item = loop.items.find((candidate) => candidate.key === key);
			if (loop.id === loopId && item) return { loop, item };
		}
		return null;
	}

	/** The item an element is in, if any. */
	function itemOf(target: EventTarget | null): { loop: Shown; item: Item } | null {
		if (!(target instanceof Node)) return null;
		for (const loop of loops) {
			for (const item of loop.items) {
				if (nodesOf(item).some((node) => node === target || node.contains(target))) return { loop, item };
			}
		}
		return null;
	}

	function focusable(element: HTMLElement): boolean {
		return element.matches("a[href], button, input, select, textarea, [tabindex], [contenteditable]");
	}

	const prepared = new WeakSet<HTMLElement>();

	/** Makes an item reachable from the keyboard (its first element takes focus) and shows its tools on hover. */
	function prepare(item: Item): void {
		const [first] = elementsOf(item);
		if (!first) return;
		if (on && !focusable(first)) {
			first.tabIndex = 0;
			first.setAttribute("data-wc-loop-focus", "");
		}
		first.setAttribute("aria-keyshortcuts", "Alt+F10");
		for (const element of elementsOf(item)) {
			if (prepared.has(element)) continue;
			prepared.add(element);
			element.addEventListener("mouseenter", () => {
				const at = itemOf(element);
				if (on && at) showTools(at.loop, at.item, false);
			});
			element.addEventListener("mouseleave", () => hideSoon());
		}
	}

	function itemLabel(loop: Shown, item: Item): string {
		return word("loopItem", { name: loop.name, n: item.index + 1, count: item.count });
	}

	// -------------------------------------------------------------------------------------------
	// The tools of an item

	function hideSoon(): void {
		cancel(hideTimer);
		hideTimer = later(() => {
			const active = kit.root.activeElement;
			// The item form keeps its item's tools, which focus goes back to when it closes.
			if (form) return;
			if (active && toolbar.contains(active)) return;
			if (itemOf(doc.activeElement)) return;
			hideTools();
		}, 400);
	}

	function hideTools(): void {
		current = null;
		toolbar.hidden = true;
		toolbar.replaceChildren();
		outline.hidden = true;
		label.hidden = true;
	}

	function showTools(loop: Shown, item: Item, fromKeyboard: boolean): void {
		cancel(hideTimer);
		const same = current?.loop.id === loop.id && current.item.key === item.key;
		current = { loop, item };
		if (!same || toolbar.hidden) renderToolbar(loop, item);
		toolbar.hidden = false;
		outline.hidden = false;
		label.hidden = false;
		label.textContent = loop.source === "items" ? `${itemLabel(loop, item)}` : word("queryItem", { name: loop.name });
		reposition();
		if (fromKeyboard && !same) kit.announce(`${itemLabel(loop, item)}. ${word("loopToolsHint")}`);
	}

	function reposition(): void {
		if (!current || toolbar.hidden) {
			for (const [id, add] of adds) positionAdd(id, add);
			return;
		}
		const rect = rectOf(current.item);
		outline.style.top = `${Math.round(rect.top - 4)}px`;
		outline.style.left = `${Math.round(rect.left - 4)}px`;
		outline.style.width = `${Math.round(rect.width + 8)}px`;
		outline.style.height = `${Math.round(rect.height + 8)}px`;
		kit.place(label, rect, 4, "above");
		kit.place(toolbar, rect, 4 + label.offsetHeight + 4, "above");
		for (const [id, add] of adds) positionAdd(id, add);
	}

	function tool(name: string, text: string, act: (event: Event) => void, disabled = false): HTMLButtonElement {
		const made = button({ class: "tool", "aria-label": text, title: text, tabindex: "-1" }, icon(name));
		made.disabled = disabled;
		made.addEventListener("click", act);
		return made;
	}

	function renderToolbar(loop: Shown, item: Item): void {
		toolbar.setAttribute("aria-label", word("loopTools", { label: itemLabel(loop, item) }));
		if (loop.source === "query") {
			const link = links.get(item.key.replace(/^entry:/, ""));
			const anchor = el(
				"a",
				{
					class: "tool-link",
					href: link?.href ?? "#",
					tabindex: "-1",
					...(link && !link.page ? { target: "_blank", rel: "noopener" } : {}),
				},
				icon("edit"),
				link?.page === false ? word("editEntryInAdmin") : word("editEntry"),
			);
			if (link?.title) anchor.setAttribute("aria-label", word("editEntryNamed", { title: link.title }));
			toolbar.replaceChildren(anchor, el("span", { class: "tool-note" }, word("queryNote")));
		} else {
			toolbar.replaceChildren(
				tool("edit", word("editItem"), (event) => void openForm(loop, item, event.currentTarget as HTMLElement)),
				tool("up", word("moveEarlier"), () => void move(loop, item, item.index - 1), item.index === 0),
				tool("down", word("moveLater"), () => void move(loop, item, item.index + 1), item.index === item.count - 1),
				tool("duplicate", word("duplicateItem"), () => void duplicate(loop, item)),
				tool("remove", word("removeItem"), () => void remove(loop, item)),
				tool("add", word("addItemAfter"), () => void add(loop, item.key)),
			);
		}
		const tools = [...toolbar.querySelectorAll<HTMLElement>("button:not(:disabled), a")];
		tools[0]?.setAttribute("tabindex", "0");
	}

	toolbar.addEventListener("keydown", (event) => {
		const tools = [...toolbar.querySelectorAll<HTMLElement>("button:not(:disabled), a")];
		const at = tools.indexOf(kit.root.activeElement as HTMLElement);
		let next = -1;
		if (event.key === "ArrowRight") next = (at + 1) % tools.length;
		else if (event.key === "ArrowLeft") next = (at - 1 + tools.length) % tools.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = tools.length - 1;
		else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			backToItem();
			return;
		} else return;
		event.preventDefault();
		for (const [index, each] of tools.entries()) each.setAttribute("tabindex", index === next ? "0" : "-1");
		tools[next]?.focus();
	});
	toolbar.addEventListener("mouseenter", () => cancel(hideTimer));
	toolbar.addEventListener("mouseleave", () => hideSoon());
	toolbar.addEventListener("focusout", (event) => {
		const next = (event as FocusEvent).relatedTarget;
		if (next instanceof Node && (toolbar.contains(next) || itemOf(next))) return;
		hideSoon();
	});

	function backToItem(): void {
		const target = current && elementsOf(current.item)[0];
		target?.focus();
	}

	function focusItem(loopId: string, key: string): void {
		const found = find(loopId, key);
		const target = found && elementsOf(found.item)[0];
		if (!found || !target) return;
		if (!focusable(target)) {
			target.tabIndex = 0;
			target.setAttribute("data-wc-loop-focus", "");
		}
		target.focus();
		showTools(found.loop, found.item, false);
	}

	// Focus moving into an item shows its tools; Alt+F10 there reaches them.
	doc.addEventListener("focusin", (event) => {
		if (!on) return;
		const at = itemOf(event.target);
		if (at) {
			showTools(at.loop, at.item, true);
			kit.placeIn(kit.pageDraft() ? { item: kit.pageDraft() ?? "", at: at.item.key } : null);
		} else if (current) hideSoon();
	});
	doc.addEventListener("keydown", (event) => {
		if (!on || event.key !== "F10" || !event.altKey) return;
		const target = event.target as HTMLElement | null;
		// Rich text keeps Alt+F10 for its own toolbar.
		if (target?.closest?.('[data-wc-type="richText"]')) return;
		const at = itemOf(target);
		if (!at) return;
		event.preventDefault();
		showTools(at.loop, at.item, false);
		toolbar.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
	});

	// -------------------------------------------------------------------------------------------
	// Changing items

	/**
	 * Shows the Loop again as the server renders it now: every appearance of it on the page takes the
	 * fresh one's nodes, and the regions in them are made editable.
	 */
	async function refreshLoop(loopId: string): Promise<void> {
		const fresh = await kit.freshPage();
		if (!fresh) {
			win.location.reload();
			return;
		}
		const freshLoops: { id: string; start: Comment; end: Comment }[] = [];
		const walker = fresh.createTreeWalker(fresh.body, NodeFilter.SHOW_COMMENT);
		const stack: { id: string; start: Comment }[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const comment = node as Comment;
			const loop = words(comment, "wc-loop");
			if (loop) stack.push({ id: (loop[0] ?? "").replace(/^loop:/, ""), start: comment });
			else if (comment.data === "/wc-loop") {
				const started = stack.pop();
				if (started) freshLoops.push({ ...started, end: comment });
			}
		}
		const wanted = freshLoops.filter((loop) => loop.id === loopId);
		const shown = loops.filter((loop) => loop.id === loopId);
		const added: Node[] = [];
		shown.forEach((loop, index) => {
			const from = wanted[index];
			if (!from) return;
			for (const node of nodesOf(loop)) node.parentNode?.removeChild(node);
			const nodes = nodesOf(from).map((node) => doc.importNode(node, true));
			loop.end.before(...nodes);
			added.push(...nodes);
		});
		kit.adopt(added);
		scan();
		await kit.refresh();
	}

	async function act(
		loop: Shown,
		action: string,
		body: object,
		after: (data: { items: string[]; item?: string; restore?: string }) => void,
	): Promise<void> {
		const answer = await call(action, { loop: loop.id, ...body });
		if (!answer.ok) {
			kit.announce(word("saveFailed", { reason: kit.errorText(answer.code) }));
			return;
		}
		const data = answer.data as { items: string[]; item?: string; restore?: string };
		await refreshLoop(loop.id);
		after(data);
	}

	async function move(loop: Shown, item: Item, to: number): Promise<void> {
		const itemId = item.key.split(":")[2] ?? "";
		await act(loop, "loop/move", { item: itemId, to }, (data) => {
			focusItem(loop.id, item.key);
			kit.announce(word("itemMoved", { n: data.items.indexOf(itemId) + 1, count: data.items.length }));
		});
	}

	async function duplicate(loop: Shown, item: Item): Promise<void> {
		await act(loop, "loop/duplicate", { item: item.key.split(":")[2] ?? "" }, (data) => {
			focusItem(loop.id, `loop:${loop.id}:${data.item}`);
			kit.announce(word("itemDuplicated"));
		});
	}

	async function add(loop: Shown, afterKey: string | null): Promise<void> {
		const after = afterKey ? (afterKey.split(":")[2] ?? null) : null;
		await act(loop, "loop/add", { after }, (data) => {
			const key = `loop:${loop.id}:${data.item}`;
			focusItem(loop.id, key);
			kit.announce(word("itemAdded"));
			const found = find(loop.id, key);
			if (found) void openForm(found.loop, found.item);
		});
	}

	async function remove(loop: Shown, item: Item): Promise<void> {
		const itemId = item.key.split(":")[2] ?? "";
		const next = loop.items[item.index + 1] ?? loop.items[item.index - 1];
		await act(loop, "loop/remove", { item: itemId }, (data) => {
			if (next) focusItem(loop.id, next.key);
			else adds.get(loop.id)?.focus();
			showNotice(loop, data.restore ?? "");
		});
	}

	/** "Item removed", with Undo, for a while: Undo puts the item back where it was. */
	function showNotice(loop: Shown, restore: string): void {
		cancel(noticeTimer);
		const undo = button({ class: "secondary small" }, icon("undo"), word("undo"));
		undo.addEventListener("click", async () => {
			undo.disabled = true;
			const answer = await call("loop/restore", { restore });
			notice.hidden = true;
			if (!answer.ok) {
				kit.announce(word("saveFailed", { reason: kit.errorText(answer.code) }));
				return;
			}
			const data = answer.data as { item: string };
			await refreshLoop(loop.id);
			focusItem(loop.id, `loop:${loop.id}:${data.item}`);
			kit.announce(word("itemRestored"));
		});
		notice.replaceChildren(el("span", {}, word("itemRemoved")), undo);
		notice.hidden = false;
		noticeTimer = later(() => {
			notice.hidden = true;
		}, 12_000);
	}

	// -------------------------------------------------------------------------------------------
	// Empty Loops: "Add item"

	function renderAdds(): void {
		const empty = new Set(loops.filter((loop) => loop.source === "items" && loop.items.length === 0).map((l) => l.id));
		for (const [id, add] of adds) {
			if (!empty.has(id) || !on) {
				add.remove();
				adds.delete(id);
			}
		}
		if (!on) return;
		for (const loop of loops) {
			if (!empty.has(loop.id) || adds.has(loop.id)) continue;
			const made = button({ class: "loop-add" }, icon("add"), word("addItemTo", { name: loop.name }));
			made.addEventListener("click", () => void add(loop, null));
			made.addEventListener("focus", () => made.scrollIntoView({ block: "nearest" }));
			kit.layer.append(made);
			adds.set(loop.id, made);
		}
		for (const [id, add] of adds) positionAdd(id, add);
	}

	function positionAdd(loopId: string, add: HTMLElement): void {
		const loop = loops.find((candidate) => candidate.id === loopId);
		if (!loop) return;
		const rect = rectOf(loop);
		add.style.top = `${Math.round(rect.top)}px`;
		add.style.left = `${Math.round(Math.max(8, rect.left))}px`;
	}

	// -------------------------------------------------------------------------------------------
	// Query Loops: where each Entry is changed

	async function loadLinks(): Promise<void> {
		const wanted = loops
			.filter((loop) => loop.source === "query")
			.flatMap((loop) => loop.items.map((item) => item.key.replace(/^entry:/, "")))
			.filter((id) => !links.has(id));
		if (wanted.length === 0) return;
		const answer = await call("loop/entries", { entries: [...new Set(wanted)], language: kit.state().language.code });
		if (!answer.ok) return;
		for (const link of (answer.data as { entries: EntryLink[] }).entries) links.set(link.id, link);
		if (current?.loop.source === "query") renderToolbar(current.loop, current.item);
	}

	// -------------------------------------------------------------------------------------------
	// The item form: every Field of an item

	/** Opens the item form; focus goes back to `from` (the tool that opened it) when it closes, else to the item. */
	async function openForm(loop: Shown, item: Item, from?: HTMLElement): Promise<void> {
		form?.close();
		const itemId = item.key.split(":")[2] ?? "";
		const language = kit.state().language;
		const answer = await call("loop/get", { loop: loop.id, item: itemId, language: language.code });
		if (!answer.ok) {
			kit.announce(word("saveFailed", { reason: kit.errorText(answer.code) }));
			return;
		}
		const data = answer.data as { fields: Field[]; item: Values };
		const titleId = "wc-item-form-title";
		const panel = el("div", {
			class: "popup dialog item-form",
			role: "dialog",
			"aria-labelledby": titleId,
			tabindex: "-1",
		});
		const status = el("p", { class: "field-status", role: "status" });
		const many = kit.state().languages.length > 1;
		const problems = new Map<string, HTMLElement>();
		let changed = false;
		let refreshTimer = 0;
		const pending = new Map<string, number>();

		const save = async (path: string, value: unknown) => {
			const values = path.split(".").reduceRight<unknown>((inner, name) => ({ [name]: inner }), value) as Values;
			const saved = await call("loop/save", { loop: loop.id, item: itemId, language: language.code, values });
			if (!saved.ok) {
				status.textContent = word("saveFailed", { reason: kit.errorText(saved.code) });
				return;
			}
			changed = true;
			const found = (saved.data as { problems: Problem[] }).problems;
			for (const [at, message] of problems) {
				const mine = found.find((problem) => problem.at.replace(/^items\[\d+\]\./, "") === at);
				message.textContent = mine ? kit.problemText(mine) : "";
				message.previousElementSibling?.setAttribute("aria-invalid", mine ? "true" : "false");
			}
			status.textContent = word("saved");
			cancel(refreshTimer);
			refreshTimer = later(() => void refreshLoop(loop.id), 700);
		};
		const queue = (path: string, value: unknown, wait = 600) => {
			cancel(pending.get(path));
			pending.set(
				path,
				later(() => void save(path, value), wait),
			);
		};

		const control = (field: Field, value: unknown, path: string): HTMLElement => {
			const id = `wc-item-${path.replace(/\W/g, "-")}`;
			const name = many && field.translatable ? `${field.label} · ${language.name}` : field.label;
			const message = el("p", { class: "field-problem", id: `${id}-problem` });
			problems.set(path, message);
			const labelled = (input: HTMLElement) => {
				input.setAttribute("aria-describedby", `${id}-problem`);
				return el("div", { class: "field" }, el("label", { for: id, class: "field-label" }, name), input, message);
			};
			switch (field.type) {
				case "text":
				case "email":
				case "number":
				case "date": {
					const type =
						field.type === "number"
							? "number"
							: field.type === "email"
								? "email"
								: field.type === "date"
									? field.mode === "time"
										? "time"
										: field.mode === "dateTime"
											? "datetime-local"
											: "date"
									: "text";
					const input = el("input", { id, type, class: "text-input", autocomplete: "off" });
					input.value =
						value === null || value === undefined
							? ""
							: field.type === "date" && field.mode === "dateTime"
								? String(value).slice(0, 16)
								: String(value);
					input.addEventListener("input", () => {
						const read =
							input.value === ""
								? null
								: field.type === "number"
									? Number(input.value)
									: field.type === "date" && field.mode === "dateTime"
										? `${input.value}:00Z`
										: input.value;
						queue(path, read);
					});
					return labelled(input);
				}
				case "richText": {
					const box = el("div", {
						id,
						class: "rich-input",
						role: "textbox",
						"aria-multiline": "true",
						contenteditable: "true",
						"aria-labelledby": `${id}-label`,
					});
					box.replaceChildren(...kit.richText(typeof value === "string" ? value : ""));
					box.addEventListener("input", () => queue(path, box.innerHTML));
					box.setAttribute("aria-describedby", `${id}-problem`);
					return el(
						"div",
						{ class: "field" },
						el("span", { id: `${id}-label`, class: "field-label" }, name),
						box,
						message,
					);
				}
				case "boolean": {
					const toggle = button({ id, class: "switch", role: "switch", "aria-checked": String(value === true) });
					toggle.addEventListener("click", () => {
						const next = toggle.getAttribute("aria-checked") !== "true";
						toggle.setAttribute("aria-checked", String(next));
						queue(path, next, 0);
					});
					return el(
						"div",
						{ class: "field switch-field" },
						el("label", { for: id, class: "field-label" }, name),
						toggle,
						message,
					);
				}
				case "select": {
					const select = el("select", { id, class: "text-input" });
					select.multiple = field.multiple === true;
					if (!field.multiple) select.append(el("option", { value: "" }, word("noChoice")));
					const chosen = Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
					for (const option of field.options ?? []) {
						const made = el("option", { value: option.value }, option.label);
						made.selected = chosen.includes(option.value);
						select.append(made);
					}
					select.addEventListener("change", () => {
						const picked = [...select.selectedOptions].map((option) => option.value).filter(Boolean);
						queue(path, field.multiple ? picked : (picked[0] ?? null), 0);
					});
					return labelled(select);
				}
				case "media": {
					const shown = el("div", { class: "media-row" });
					const draw = (media: MediaChoice | null, mediaId: string | null) => {
						const change = button(
							{ class: "secondary small", "aria-label": `${word("change")}: ${name}` },
							word("change"),
						);
						change.addEventListener("click", async () => {
							const picked = await kit.pickImage({ title: field.label, current: mediaId, from: change });
							if (!picked) return;
							draw(picked, picked.id);
							queue(path, picked.id, 0);
						});
						const children: (Node | string)[] = [];
						if (media?.thumbnail) children.push(el("img", { src: media.thumbnail, alt: "", class: "media-thumb" }));
						children.push(
							el("span", { class: "media-name" }, media?.fileName ?? (mediaId ? "" : word("noImage"))),
							change,
						);
						if (mediaId) {
							const clear = button({ class: "link-button" }, word("removeImage"));
							clear.addEventListener("click", () => {
								draw(null, null);
								queue(path, null, 0);
							});
							children.push(clear);
						}
						shown.replaceChildren(...children);
					};
					const mediaId = typeof value === "string" ? value : null;
					draw(null, mediaId);
					if (mediaId) {
						void call("media/get", { media: mediaId, language: language.code }).then((loaded) => {
							if (loaded.ok) draw((loaded.data as { media: MediaChoice }).media, mediaId);
						});
					}
					return el("div", { class: "field" }, el("span", { class: "field-label" }, name), shown, message);
				}
				case "link": {
					const link = (value ?? {}) as { url?: string | null; text?: string | null };
					const address = el("input", { id, type: "text", class: "text-input", autocomplete: "off" });
					const text = el("input", { id: `${id}-text`, type: "text", class: "text-input", autocomplete: "off" });
					address.value = link.url ?? "";
					text.value = link.text ?? "";
					const changedLink = () =>
						queue(path, address.value || text.value ? { url: address.value, text: text.value } : null);
					address.addEventListener("input", changedLink);
					text.addEventListener("input", changedLink);
					address.setAttribute("aria-describedby", `${id}-problem`);
					return el(
						"div",
						{ class: "field" },
						el("label", { for: id, class: "field-label" }, `${name} · ${word("linkAddress")}`),
						address,
						el("label", { for: `${id}-text`, class: "field-label" }, `${name} · ${word("linkText")}`),
						text,
						message,
					);
				}
				case "group": {
					const inner = (value ?? {}) as Values;
					return el(
						"fieldset",
						{ class: "field-group" },
						el("legend", { class: "field-label" }, field.label),
						...(field.fields ?? []).map((each) => control(each, inner[each.key], `${path}.${each.key}`)),
					);
				}
				default:
					return el(
						"div",
						{ class: "field" },
						el("span", { class: "field-label" }, name),
						el("p", { class: "help" }, word("changeInAdmin")),
					);
			}
		};

		const closeButton = button({ class: "icon-button", "aria-label": word("close") }, icon("close"));
		let sheet: ReturnType<BarKit["sheet"]> | null = null;
		const onScroll = () => {
			const rect = rectOf(item);
			if (!sheet) kit.place(panel, rect, 8, "below");
		};
		const done = (returnFocus: boolean) => {
			for (const timer of pending.values()) cancel(timer);
			win.removeEventListener("scroll", onScroll, true);
			if (sheet) {
				const was = sheet;
				sheet = null;
				was.close();
			} else panel.remove();
			form = null;
			if (changed) void refreshLoop(loop.id);
			if (!returnFocus) return;
			if (from?.isConnected && !toolbar.hidden) from.focus();
			else focusItem(loop.id, item.key);
		};
		form = { close: () => done(false) };
		closeButton.addEventListener("click", () => done(true));
		panel.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				done(true);
			}
		});
		panel.append(
			el(
				"div",
				{ class: "panel-head" },
				el("h2", { id: titleId, class: "panel-title" }, icon("loop"), itemLabel(loop, item)),
				closeButton,
			),
			el(
				"div",
				{ class: "item-fields" },
				...data.fields.map((field) => control(field, data.item[field.key], field.key)),
			),
			status,
		);
		if (kit.phone()) {
			// The sheet is the dialog, with its own title and close button.
			panel.removeAttribute("role");
			panel.removeAttribute("aria-labelledby");
			panel.className = "sheet-body";
			panel.querySelector(".panel-head")?.remove();
			sheet = kit.sheet({
				title: itemLabel(loop, item),
				from: elementsOf(item)[0] ?? null,
				content: panel,
				onClose: () => {
					if (form) done(false);
				},
			});
		} else {
			kit.layer.append(panel);
			onScroll();
			win.addEventListener("scroll", onScroll, { passive: true, capture: true });
		}
		panel.querySelector<HTMLElement>("input, select, [contenteditable], button.switch")?.focus();
	}

	// -------------------------------------------------------------------------------------------

	function mode(next: boolean): void {
		on = next;
		for (const loop of loops) {
			for (const item of loop.items) {
				const [first] = elementsOf(item);
				if (!first) continue;
				if (!on && first.hasAttribute("data-wc-loop-focus")) {
					first.removeAttribute("tabindex");
					first.removeAttribute("data-wc-loop-focus");
				} else if (on && !focusable(first)) {
					first.tabIndex = 0;
					first.setAttribute("data-wc-loop-focus", "");
				}
			}
		}
		if (!on) {
			hideTools();
			form?.close();
			notice.hidden = true;
		}
		renderAdds();
	}

	function targets(): PresenceTarget[] {
		const draft = kit.pageDraft();
		if (!draft) return [];
		return loops.flatMap((loop) => loop.items.map((item) => ({ item: draft, at: item.key, rect: () => rectOf(item) })));
	}

	return {
		scan,
		mode,
		targets,
		close: () => {
			hideTools();
			form?.close();
		},
		reposition,
	};
}
