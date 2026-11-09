/** What the editing bar's script is given when it is made: the address of its own stylesheet. */
export type EditingBarConfig = { styles: string };

/**
 * The editing bar: WebCraft's own script on a page in Edit mode (ADR 0022). It is served as a file
 * from the Site's domain, made of this function's source text and its config (`assets.ts`), so the
 * function must use nothing from outside itself.
 *
 * It runs first on the page, keeping the browser functions it needs before any Site script could
 * replace them, and draws itself in a shadow root, so the Site's CSS can't reach it. It shows the
 * dark editing bar (page switcher, Draft status, Edit and Preview, device widths, language,
 * Publish menu), makes the tagged regions editable in place (a floating toolbar for rich text),
 * saves every change to the Draft as people type, and announces saves in a live region.
 */
export function editingBar(config: EditingBarConfig): void {
	type Words = { [key: string]: string | Words };
	type Change = {
		item: string;
		key: string;
		label: string | null;
		type: string;
		by: { name: string; you: boolean } | null;
	};
	type State = {
		page: { title: string; path: string; item: string | null };
		canPublish: boolean;
		canCode: boolean;
		changes: Change[];
		publishAll: { url: string; otherDrafts: number };
		pages: { title: string; path: string }[];
		person: { name: string };
		site: { name: string };
		language: { code: string; name: string };
		languages: { code: string; name: string; path: string; current: boolean }[];
		words?: Words;
	};
	type Answer = { ok: true; data: unknown } | { ok: false; code: string };
	type Problem = { at: string; message: string; rule?: string };
	type Popup = { trigger: HTMLButtonElement; panel: HTMLElement; focus(): void; render?(): void };

	const win = window;
	const doc = document;
	// Kept now, before any Site script runs (this script is the first on the page).
	const send = win.fetch.bind(win);
	const encode = JSON.stringify;
	const later = win.setTimeout.bind(win);
	const cancel = win.clearTimeout.bind(win);
	const every = win.setInterval.bind(win);
	const token = doc.querySelector('meta[name="webcraft-edit-token"]')?.getAttribute("content") ?? "";
	const path = win.location.pathname;
	const SVG = "http://www.w3.org/2000/svg";
	const HINT_KEY = "webcraft-edit-hint";
	const PREVIEW_KEY = "webcraft-edit-preview";
	/** Whether the page was rendered for Code mode (ADR 0016): its own script then runs its panels. */
	const coding = doc.querySelector('meta[name="webcraft-code-mode"]')?.getAttribute("content") === "on";
	/** Lucide-style icons (24 × 24, stroked), by name. */
	const ICONS: Record<string, string[]> = {
		edit: [
			"M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z",
			"m15 5 4 4",
		],
		preview: [
			"M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0",
			"M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6",
		],
		code: ["m18 16 4-4-4-4", "m6 8-4 4 4 4", "m14.5 4-5 16"],
		desktop: ["M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8 21h8", "M12 17v4"],
		tablet: ["M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M12 18h.01"],
		phone: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M12 18h.01"],
		language: ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"],
		publish: ["M12 3v12", "m17 8-5-5-5 5", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
		chevron: ["m6 9 6 6 6-6"],
		page: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
		text: ["M4 7V4h16v3", "M9 20h6", "M12 4v16"],
		bold: ["M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"],
		italic: ["M19 4h-9", "M14 20H5", "M15 4 9 20"],
		link: [
			"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
			"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
		],
		bulletList: ["M3 12h.01", "M3 18h.01", "M3 6h.01", "M8 12h13", "M8 18h13", "M8 6h13"],
		numberedList: ["M10 12h11", "M10 18h11", "M10 6h11", "M4 10h2", "M4 6h1v4", "M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"],
		clearFormatting: ["M4 7V4h16v3", "M5 20h6", "M13 4 8 20", "m15 15 5 5", "m20 15-5 5"],
		undo: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
		info: ["M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20", "M12 16v-4", "M12 8h.01"],
		pointer: ["M14 4.1 12 6", "m5.1 8-2.9-.8", "m6 12-1.9 2", "M7.2 2.2 8 5.1", "m9 9 4 12 2-5 5-2z"],
		admin: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
		end: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "m16 17 5-5-5-5", "M21 12H9"],
		saved: ["M20 6 9 17l-5-5"],
	};

	let state: State | null = null;
	let words: Words = {};
	let editing = true;
	let ended = false;

	let host: HTMLElement;
	let root: ShadowRoot;
	let bar: HTMLElement;
	let live: HTMLElement;
	let chip: HTMLElement;
	let savedNote: HTMLElement;
	let pageButton: HTMLButtonElement;
	let publishButton: HTMLButtonElement;
	let tag: HTMLElement;
	let problem: HTMLElement;
	let toolbar: HTMLElement;
	let linkForm: HTMLElement;
	let linkInput: HTMLInputElement;
	let openPopup: Popup | null = null;
	let publishPopup: Popup;
	let savedTimer = 0;

	const regions: HTMLElement[] = [];
	/** How each region is made editable: `plaintext-only` for plain text where the browser has it. */
	const editableAs = new Map<HTMLElement, string>();
	const lastSaved = new Map<HTMLElement, string>();
	const timers = new Map<HTMLElement, number>();
	const saving = new Map<HTMLElement, Promise<void>>();
	const problems = new Map<HTMLElement, string>();
	let current: HTMLElement | null = null;
	let selection: Range | null = null;
	let toolbarDismissed = false;

	if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", () => void start(), { once: true });
	else void start();

	// ---------------------------------------------------------------------------------------------
	// Talking to the Site's Edit mode endpoint

	async function call(action: string, body: object): Promise<Answer> {
		try {
			const response = await send(`/_webcraft/edit/api/${action}`, {
				method: "POST",
				credentials: "same-origin",
				cache: "no-store",
				headers: { "content-type": "application/json", "x-webcraft-edit-token": token },
				body: encode(body),
			});
			const data = (await response.json().catch(() => ({}))) as { code?: string };
			if (response.ok) return { ok: true, data };
			if (data.code === "EDIT_MODE_ENDED") end();
			return { ok: false, code: data.code ?? "generic" };
		} catch {
			return { ok: false, code: "generic" };
		}
	}

	async function start(): Promise<void> {
		const answer = await call("state", { path });
		if (!answer.ok) return;
		state = answer.data as State;
		words = state.words ?? {};
		build();
		setUpRegions();
		every(() => void refresh(), 60_000);
		doc.addEventListener("visibilitychange", () => {
			if (doc.visibilityState === "visible") void refresh();
		});
	}

	/** Reads the page's state again: its changes for the Publish menu, and whether Edit mode still holds. */
	async function refresh(): Promise<void> {
		if (ended) return;
		const answer = await call("state", { path });
		if (!answer.ok) return;
		state = { ...(answer.data as State), words };
		renderStatus();
		if (openPopup === publishPopup) publishPopup.render?.();
	}

	// ---------------------------------------------------------------------------------------------
	// Words and elements

	function word(key: string, values: Record<string, string | number> = {}): string {
		let found: string | Words | undefined = words;
		for (const part of key.split(".")) found = typeof found === "object" ? found[part] : undefined;
		const text = typeof found === "string" ? found : key;
		return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
	}

	function el<Tag extends keyof HTMLElementTagNameMap>(
		tagName: Tag,
		attributes: Record<string, string> = {},
		...children: (Node | string)[]
	): HTMLElementTagNameMap[Tag] {
		const node = doc.createElement(tagName);
		for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
		node.append(...children);
		return node;
	}

	function icon(name: string): SVGSVGElement {
		const svg = doc.createElementNS(SVG, "svg");
		for (const [key, value] of Object.entries({
			viewBox: "0 0 24 24",
			width: "16",
			height: "16",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"aria-hidden": "true",
			focusable: "false",
		})) {
			svg.setAttribute(key, value);
		}
		for (const d of ICONS[name] ?? []) {
			const line = doc.createElementNS(SVG, "path");
			line.setAttribute("d", d);
			svg.append(line);
		}
		return svg;
	}

	function button(attributes: Record<string, string>, ...children: (Node | string)[]): HTMLButtonElement {
		return el("button", { type: "button", ...attributes }, ...children);
	}

	function announce(text: string): void {
		live.textContent = "";
		later(() => {
			live.textContent = text;
		}, 60);
	}

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		return (
			((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?"
		);
	}

	// ---------------------------------------------------------------------------------------------
	// The bar

	function build(): void {
		const s = state as State;
		host = doc.createElement("webcraft-edit-bar");
		root = host.attachShadow({ mode: "open" });
		live = el("p", { role: "status", class: "sr-only" });
		chip = el("span", { class: "chip" });
		savedNote = el("span", { class: "saved optional" });
		const name = el("span", { class: "site optional" }, s.site.name);

		pageButton = button(
			{ class: "control pages", "aria-haspopup": "menu", "aria-expanded": "false" },
			icon("page"),
			el("span", { class: "page-title" }),
			icon("chevron"),
		);
		const pagesMenu = el("div", { class: "popup menu", role: "menu", "aria-label": word("pages"), hidden: "" });
		const pagesPopup: Popup = {
			trigger: pageButton,
			panel: pagesMenu,
			focus: () => focusMenuItem(pagesMenu, 0),
			render() {
				pagesMenu.replaceChildren(
					...(state?.pages ?? []).map((page) =>
						el(
							"a",
							{
								role: "menuitem",
								tabindex: "-1",
								href: page.path,
								...(page.path === state?.page.path ? { "aria-current": "page" } : {}),
							},
							el("span", { class: "menu-title" }, page.title || page.path),
							el("span", { class: "menu-sub" }, page.path),
						),
					),
				);
			},
		};
		popupTrigger(pagesPopup);
		pagesMenu.addEventListener("keydown", (event) => menuKeys(event, pagesMenu));

		const modeEdit = button({ class: "segment", "aria-pressed": "true" }, icon("edit"), word("edit"));
		const modePreview = button({ class: "segment", "aria-pressed": "false" }, icon("preview"), word("preview"));
		const modes = el("div", { class: "segments", role: "group", "aria-label": word("modes") }, modeEdit, modePreview);
		const setMode = (on: boolean) => {
			editing = on && !ended && !coding;
			modeEdit.setAttribute("aria-pressed", String(editing));
			modePreview.setAttribute("aria-pressed", String(!editing && !coding));
			applyMode();
		};
		// Code mode (ADR 0016) is Staff's: turning it on or off renders the page again, with the Drafts
		// of the Site's Structure or without them.
		const switchCode = async (on: boolean, preview = false) => {
			const answer = await call(on ? "code/start" : "code/stop", {});
			if (!answer.ok) return;
			try {
				if (preview) win.sessionStorage.setItem(PREVIEW_KEY, "on");
			} catch {
				// Without storage the page opens in Edit.
			}
			win.location.reload();
		};
		modeEdit.addEventListener("click", () => (coding ? void switchCode(false) : setMode(true)));
		modePreview.addEventListener("click", () => (coding ? void switchCode(false, true) : setMode(false)));
		if (s.canCode || coding) {
			const modeCode = button({ class: "segment", "aria-pressed": String(coding) }, icon("code"), word("codeButton"));
			modeCode.addEventListener("click", () => {
				if (!coding) void switchCode(true);
			});
			modes.append(modeCode);
		}
		if (coding) {
			// In Code mode a click selects an element instead: nothing is edited in place.
			editing = false;
			modeEdit.setAttribute("aria-pressed", "false");
			modePreview.setAttribute("aria-pressed", "false");
		} else {
			try {
				if (win.sessionStorage.getItem(PREVIEW_KEY) === "on") {
					win.sessionStorage.removeItem(PREVIEW_KEY);
					later(() => setMode(false), 0);
				}
			} catch {
				// Nothing kept: the page opens in Edit.
			}
		}

		const devices = el("div", { class: "segments devices optional", role: "group", "aria-label": word("devices") });
		for (const device of ["desktop", "tablet", "phone"] as const) {
			const choice = button(
				{ class: "segment icon-only", "aria-pressed": String(device === "desktop"), "aria-label": word(device) },
				icon(device),
			);
			choice.addEventListener("click", () => {
				for (const other of devices.querySelectorAll("button")) other.setAttribute("aria-pressed", "false");
				choice.setAttribute("aria-pressed", "true");
				doc.documentElement.classList.toggle("wc-edit-tablet", device === "tablet");
				doc.documentElement.classList.toggle("wc-edit-phone", device === "phone");
			});
			devices.append(choice);
		}

		// With more than one language, the page in each of them is a menu away.
		const languageMenu = el("div", { class: "popup menu", role: "menu", "aria-label": word("languages"), hidden: "" });
		let language: HTMLElement;
		if (s.languages.length > 1) {
			const languageButton = button(
				{
					class: "control language",
					"aria-haspopup": "menu",
					"aria-expanded": "false",
					// The name holds the code it shows, then the language's name.
					"aria-label": word("languageSwitcher", {
						language: `${s.language.code.toUpperCase()} (${s.language.name})`,
					}),
				},
				icon("language"),
				el("span", {}, s.language.code.toUpperCase()),
				icon("chevron"),
			);
			popupTrigger({
				trigger: languageButton,
				panel: languageMenu,
				focus: () => focusMenuItem(languageMenu, 0),
				render() {
					languageMenu.replaceChildren(
						...(state?.languages ?? []).map((choice) =>
							el(
								"a",
								{
									role: "menuitem",
									tabindex: "-1",
									href: choice.path,
									hreflang: choice.code,
									...(choice.current ? { "aria-current": "page" } : {}),
								},
								el("span", { class: "menu-title", lang: choice.code }, choice.name),
								el("span", { class: "menu-sub" }, choice.code),
							),
						),
					);
				},
			});
			languageMenu.addEventListener("keydown", (event) => menuKeys(event, languageMenu));
			language = languageButton;
		} else {
			language = el(
				"span",
				{ class: "language" },
				icon("language"),
				el("span", { class: "sr-only" }, word("language")),
				s.language.code.toUpperCase(),
			);
		}

		publishButton = button({ class: "publish", "aria-haspopup": "dialog", "aria-expanded": "false" });
		const publishPanel = el("div", {
			class: "popup dialog",
			role: "dialog",
			"aria-labelledby": "wc-publish-title",
			tabindex: "-1",
			hidden: "",
		});
		publishPopup = {
			trigger: publishButton,
			panel: publishPanel,
			focus: () => publishPanel.focus(),
			render: () => renderPublish(publishPanel),
		};
		popupTrigger(publishPopup);

		const account = button(
			{ class: "avatar", "aria-haspopup": "menu", "aria-expanded": "false" },
			el("span", { "aria-hidden": "true" }, initials(s.person.name)),
			el("span", { class: "sr-only" }, word("account", { name: s.person.name })),
		);
		const accountMenu = el("div", { class: "popup menu", role: "menu", "aria-label": word("label"), hidden: "" });
		const accountPopup: Popup = {
			trigger: account,
			panel: accountMenu,
			focus: () => focusMenuItem(accountMenu, 0),
			render() {
				const endItem = button({ role: "menuitem", tabindex: "-1", class: "menu-row" }, icon("end"), word("end"));
				endItem.addEventListener("click", async () => {
					await call("end", {});
					win.location.reload();
				});
				accountMenu.replaceChildren(
					el(
						"a",
						{ role: "menuitem", tabindex: "-1", href: state?.publishAll.url ?? "/", class: "menu-row" },
						icon("admin"),
						word("openAdmin"),
					),
					endItem,
				);
			},
		};
		popupTrigger(accountPopup);
		accountMenu.addEventListener("keydown", (event) => menuKeys(event, accountMenu));

		tag = el("div", { class: "tag", "aria-hidden": "true", hidden: "" });
		problem = el("div", { class: "problem", "aria-hidden": "true", hidden: "" });
		toolbar = buildToolbar();

		bar = el(
			"div",
			{ class: "bar" },
			el(
				"div",
				{ class: "start" },
				el("span", { class: "logo", "aria-hidden": "true" }, "W"),
				name,
				el("span", { class: "divider optional", "aria-hidden": "true" }, "/"),
				pageButton,
				pagesMenu,
				chip,
				savedNote,
			),
			el("div", { class: "middle" }, modes, devices),
			el("div", { class: "end" }, language, languageMenu, publishButton, publishPanel, account, accountMenu),
		);
		const section = el(
			"section",
			{ class: "edit-mode", "aria-label": word("label") },
			bar,
			live,
			tag,
			problem,
			toolbar,
		);
		const hint = buildHint();
		if (hint) section.append(hint);
		root.append(el("link", { rel: "stylesheet", href: config.styles }), section);

		const skip = doc.querySelector("body > a.wc-skip-link");
		if (skip) skip.after(host);
		else doc.body.prepend(host);
		doc.documentElement.classList.add("wc-edit", "wc-edit-on");

		root.addEventListener("keydown", (event) => {
			const key = (event as KeyboardEvent).key;
			if (key === "Escape" && openPopup) {
				event.preventDefault();
				closePopup(true);
			}
		});
		doc.addEventListener("pointerdown", (event) => {
			if (!openPopup) return;
			const through = event.composedPath();
			if (!through.includes(openPopup.panel) && !through.includes(openPopup.trigger)) closePopup(false);
		});
		// The bar never covers what has focus: the page scrolls it into view below the bar.
		doc.addEventListener("focusin", (event) => {
			const target = event.target;
			if (!(target instanceof Element) || target === host) return;
			const top = target.getBoundingClientRect().top;
			const below = bar.getBoundingClientRect().bottom + 8;
			if (top < below) win.scrollBy({ top: top - below, behavior: "instant" });
		});
		renderStatus();
	}

	function buildHint(): HTMLElement | null {
		// Code mode's panels say how to start there.
		if (coding) return null;
		try {
			if (win.localStorage.getItem(HINT_KEY) === "seen") return null;
		} catch {
			// Without storage the hint shows each time; that's all.
		}
		const dismiss = button({ class: "primary small" }, word("hintDismiss"));
		const hint = el(
			"div",
			{ class: "hint" },
			el("p", { class: "hint-title" }, icon("pointer"), word("hintTitle", { title: state?.page.title ?? "" })),
			el("p", { class: "hint-text" }, word("hintText")),
			el("div", { class: "hint-actions" }, dismiss),
		);
		dismiss.addEventListener("click", () => {
			try {
				win.localStorage.setItem(HINT_KEY, "seen");
			} catch {
				// Not kept; it shows again next time.
			}
			hint.remove();
			pageButton.focus();
		});
		return hint;
	}

	function renderStatus(): void {
		const s = state as State;
		pageButton.querySelector(".page-title")?.replaceChildren(s.page.title || s.page.path);
		pageButton.setAttribute("aria-label", word("pageSwitcher", { title: s.page.title || s.page.path }));
		const count = s.changes.length;
		chip.className = count > 0 ? "chip draft" : "chip";
		chip.textContent = ended
			? word("ended")
			: count === 0
				? word("noChanges")
				: count === 1
					? word("draftOne")
					: word("draftOther", { count });
		publishButton.replaceChildren(
			icon(s.canPublish ? "publish" : "saved"),
			s.canPublish ? word("publish") : word("changes"),
			icon("chevron"),
		);
		publishButton.disabled = ended;
	}

	function renderPublish(panel: HTMLElement): void {
		const s = state as State;
		const error = el("p", { class: "error", role: "alert" });
		const list =
			s.changes.length === 0
				? el("p", { class: "empty" }, word("nothingToPublish"))
				: el(
						"ul",
						{ class: "changes" },
						...s.changes.map((change) => {
							const label = change.label ?? word(`builtIns.${change.key}`);
							const type = word(`types.${change.type}`);
							const by = change.by
								? change.by.you
									? word("changedByYou", { type })
									: word("changedBy", { type, name: change.by.name })
								: word("changed", { type });
							const undo = button({ class: "link-button", "aria-label": word("undoChange", { label }) }, word("undo"));
							undo.addEventListener("click", async () => {
								undo.disabled = true;
								const answer = await call("undo", { path, item: change.item, key: change.key });
								if (answer.ok) win.location.reload();
								else {
									undo.disabled = false;
									error.textContent = errorText(answer.code);
								}
							});
							return el(
								"li",
								{},
								icon(change.type === "text" || change.type === "richText" ? "text" : "page"),
								el(
									"span",
									{ class: "change" },
									el("span", { class: "change-label" }, label),
									el("span", { class: "change-sub" }, change.item === "globals" ? `${by} · ${word("globals")}` : by),
								),
								undo,
							);
						}),
					);
		const actions = el("div", { class: "actions" });
		if (s.changes.length > 0) {
			const discard = button({ class: "danger-button" }, word("discard"));
			discard.addEventListener("click", () => {
				const yes = button({ class: "danger small" }, word("discardYes"));
				const no = button({ class: "secondary small" }, word("discardNo"));
				const confirm = el(
					"div",
					{ class: "confirm" },
					el("p", {}, word("discardConfirm")),
					el("div", { class: "confirm-actions" }, no, yes),
				);
				actions.replaceChildren(confirm);
				no.focus();
				no.addEventListener("click", () => {
					renderPublish(panel);
					panel.querySelector<HTMLElement>(".danger-button")?.focus();
				});
				yes.addEventListener("click", async () => {
					yes.disabled = true;
					const answer = await call("discard", { path });
					if (answer.ok) win.location.reload();
					else {
						yes.disabled = false;
						error.textContent = errorText(answer.code);
					}
				});
			});
			actions.append(discard);
		}
		if (s.canPublish) {
			const publish = button({ class: "primary" }, icon("publish"), word("publishPage"));
			publish.disabled = s.changes.length === 0;
			publish.addEventListener("click", async () => {
				publish.disabled = true;
				publish.replaceChildren(word("publishing"));
				const answer = await call("publish", { path });
				if (answer.ok) {
					state = { ...(answer.data as State), words };
					renderStatus();
					renderPublish(panel);
					panel.focus();
					announce(word("published"));
				} else {
					publish.disabled = false;
					publish.replaceChildren(icon("publish"), word("publishPage"));
					error.textContent = errorText(answer.code);
				}
			});
			actions.append(publish);
		} else {
			actions.append(el("p", { class: "draft-note" }, icon("saved"), word("savedToDraft")));
		}
		const others = s.publishAll.otherDrafts;
		panel.replaceChildren(
			el(
				"h2",
				{ id: "wc-publish-title" },
				s.canPublish ? word("publishTitle", { title: s.page.title }) : word("changesTitle", { title: s.page.title }),
			),
			el("p", { class: "intro" }, s.canPublish ? word("publishIntro") : word("authorIntro")),
			list,
			error,
			actions,
			el(
				"p",
				{ class: "others" },
				icon("info"),
				el(
					"span",
					{},
					others === 0
						? word("otherDraftsNone")
						: others === 1
							? word("otherDraftsOne")
							: word("otherDraftsOther", { count: others }),
					" ",
					el("a", { href: s.publishAll.url }, word("publishAll")),
				),
			),
		);
	}

	function errorText(code: string): string {
		const text = word(`errors.${code}`);
		return text === `errors.${code}` ? word("errors.generic") : text;
	}

	// ---------------------------------------------------------------------------------------------
	// Menus and the Publish menu: open from their button, Escape closes them and returns focus

	function popupTrigger(popup: Popup): void {
		popup.trigger.addEventListener("click", () => {
			if (openPopup === popup) closePopup(true);
			else openPanel(popup);
		});
		popup.trigger.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown" && popup.panel.getAttribute("role") === "menu") {
				event.preventDefault();
				openPanel(popup);
			}
		});
		popup.panel.addEventListener("focusout", (event) => {
			const next = (event as FocusEvent).relatedTarget;
			if (openPopup === popup && next instanceof Node && !popup.panel.contains(next) && next !== popup.trigger) {
				closePopup(false);
			}
		});
	}

	function openPanel(popup: Popup): void {
		if (openPopup) closePopup(false);
		popup.render?.();
		popup.panel.hidden = false;
		popup.trigger.setAttribute("aria-expanded", "true");
		openPopup = popup;
		// Under its button: from its start, or ending with it for the buttons at the end of the bar.
		const rect = popup.trigger.getBoundingClientRect();
		const width = popup.panel.offsetWidth;
		const fromEnd = rect.left > win.innerWidth / 2;
		const left = fromEnd ? rect.right - width : rect.left;
		popup.panel.style.top = `${Math.round(rect.bottom + 6)}px`;
		popup.panel.style.left = `${Math.round(Math.max(8, Math.min(left, win.innerWidth - width - 8)))}px`;
		popup.focus();
	}

	function closePopup(returnFocus: boolean): void {
		const popup = openPopup;
		if (!popup) return;
		openPopup = null;
		popup.panel.hidden = true;
		// What a popup shows is made when it opens: none of its links stay on the page while it is closed.
		popup.panel.replaceChildren();
		popup.trigger.setAttribute("aria-expanded", "false");
		if (returnFocus) popup.trigger.focus();
	}

	function focusMenuItem(menu: HTMLElement, index: number): void {
		const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
		items[(index + items.length) % Math.max(items.length, 1)]?.focus();
	}

	function menuKeys(event: KeyboardEvent, menu: HTMLElement): void {
		const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
		const at = items.indexOf(root.activeElement as HTMLElement);
		switch (event.key) {
			case "ArrowDown":
				focusMenuItem(menu, at + 1);
				break;
			case "ArrowUp":
				focusMenuItem(menu, at - 1);
				break;
			case "Home":
				focusMenuItem(menu, 0);
				break;
			case "End":
				focusMenuItem(menu, items.length - 1);
				break;
			case "Tab":
				closePopup(false);
				return;
			default:
				return;
		}
		event.preventDefault();
	}

	// ---------------------------------------------------------------------------------------------
	// Editing in place

	function setUpRegions(): void {
		const plainTextOnly = (() => {
			try {
				const probe = doc.createElement("div");
				probe.contentEditable = "plaintext-only";
				return probe.contentEditable === "plaintext-only";
			} catch {
				return false;
			}
		})();
		for (const region of doc.querySelectorAll<HTMLElement>("[data-wc-item][data-wc-field]")) {
			const rich = region.dataset.wcType === "richText";
			editableAs.set(region, rich ? "true" : plainTextOnly ? "plaintext-only" : "true");
			regions.push(region);
			lastSaved.set(region, textIn(region));
			region.addEventListener("focus", () => focusRegion(region));
			region.addEventListener("blur", () => blurRegion(region));
			region.addEventListener("input", () => {
				toolbarDismissed = false;
				if (rich) showToolbar(region);
				queueSave(region, 800);
			});
			region.addEventListener("keydown", (event) => regionKeys(event, region));
			region.addEventListener("paste", (event) => {
				if (rich || editableAs.get(region) === "plaintext-only") return;
				// Plain text Fields take text only, whatever the clipboard holds.
				event.preventDefault();
				doc.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
			});
			region.addEventListener("mouseenter", () => {
				if (editing && !ended) showTag(region);
			});
			region.addEventListener("mouseleave", () => {
				if (current !== region) hideTag();
			});
		}
		doc.addEventListener("selectionchange", () => {
			rememberSelection();
			if (current?.dataset.wcType === "richText") updatePressed();
		});
		const reposition = () => {
			if (current) {
				showTag(current);
				if (!toolbar.hidden) showToolbar(current);
			}
		};
		win.addEventListener("scroll", reposition, { passive: true, capture: true });
		win.addEventListener("resize", reposition, { passive: true });
		applyMode();
	}

	function applyMode(): void {
		const on = editing && !ended;
		doc.documentElement.classList.toggle("wc-edit-on", on);
		for (const region of regions) {
			if (on) {
				region.setAttribute("contenteditable", editableAs.get(region) ?? "true");
				region.spellcheck = true;
			} else {
				region.removeAttribute("contenteditable");
			}
		}
		if (!on) {
			hideTag();
			hideToolbar();
		}
	}

	function textIn(region: HTMLElement): string {
		if (region.dataset.wcType === "richText") return region.innerHTML;
		return (region.textContent ?? "").replace(/[\r\n]+/g, " ");
	}

	function focusRegion(region: HTMLElement): void {
		if (!editing || ended) return;
		current = region;
		showTag(region);
		showProblem(region);
		if (region.dataset.wcType === "richText" && !toolbarDismissed) showToolbar(region);
	}

	function blurRegion(region: HTMLElement): void {
		void save(region);
		// Once focus has moved: into the toolbar (inside the bar's shadow root) it keeps editing open.
		later(() => {
			if (doc.activeElement === region || (root.activeElement && toolbar.contains(root.activeElement))) return;
			if (current !== region) return;
			current = null;
			hideTag();
			hideToolbar();
			problem.hidden = true;
		}, 0);
	}

	function regionKeys(event: KeyboardEvent, region: HTMLElement): void {
		if (region.dataset.wcType !== "richText") {
			// Plain text is one line.
			if (event.key === "Enter") event.preventDefault();
			return;
		}
		if (event.key === "F10" && event.altKey) {
			event.preventDefault();
			// The selection as it is now: a "selectionchange" for it may not have come yet.
			rememberSelection();
			toolbarDismissed = false;
			showToolbar(region);
			toolbar.querySelector<HTMLElement>('button[tabindex="0"]')?.focus();
		}
	}

	function queueSave(region: HTMLElement, delay: number): void {
		cancel(timers.get(region));
		timers.set(
			region,
			later(() => void save(region), delay),
		);
	}

	async function save(region: HTMLElement): Promise<void> {
		cancel(timers.get(region));
		timers.delete(region);
		await saving.get(region);
		const value = textIn(region);
		if (ended || value === lastSaved.get(region)) return;
		const run = (async () => {
			savedNote.textContent = word("saving");
			const answer = await call("save", {
				item: region.dataset.wcItem,
				field: region.dataset.wcField,
				value,
				language: state?.language.code,
			});
			if (!answer.ok) {
				const reason = errorText(answer.code);
				savedNote.textContent = word("saveFailed", { reason });
				announce(word("saveFailed", { reason }));
				return;
			}
			const saved = answer.data as { value: unknown; problems: Problem[] };
			lastSaved.set(region, value);
			const found = saved.problems[0];
			if (found) problems.set(region, problemText(found));
			else problems.delete(region);
			region.toggleAttribute("data-wc-invalid", Boolean(found));
			if (current === region) showProblem(region);
			// Rich text comes back cleaned; once the person has moved on, the region shows it as stored.
			if (typeof saved.value === "string" && current !== region && saved.value !== textIn(region)) {
				if (region.dataset.wcType === "richText") region.innerHTML = saved.value;
				else region.textContent = saved.value;
				lastSaved.set(region, textIn(region));
			}
			savedNote.textContent = word("savedJustNow");
			cancel(savedTimer);
			savedTimer = later(() => {
				savedNote.textContent = word("saved");
			}, 60_000);
			announce(found ? `${word("saved")}. ${problemText(found)}` : word("saved"));
			await refresh();
		})();
		saving.set(region, run);
		await run;
	}

	function problemText(found: Problem): string {
		const text = word(`problems.${found.rule ?? "other"}`);
		return text.startsWith("problems.") ? word("problems.other") : text;
	}

	/** Places a floating element next to `rect`: above it when there is room below the bar, else below. */
	function place(panel: HTMLElement, rect: DOMRect, gap: number, prefer: "above" | "below"): void {
		const barBottom = bar.getBoundingClientRect().bottom;
		const height = panel.offsetHeight;
		let top = prefer === "above" ? rect.top - height - gap : rect.bottom + gap;
		if (prefer === "above" && top < barBottom + 4) top = rect.bottom + gap;
		const left = Math.max(8, Math.min(rect.left, win.innerWidth - panel.offsetWidth - 8));
		panel.style.top = `${Math.round(top)}px`;
		panel.style.left = `${Math.round(left)}px`;
	}

	function showTag(region: HTMLElement): void {
		const label = region.dataset.wcLabel ?? word(`builtIns.${region.dataset.wcField ?? ""}`);
		tag.textContent = word("regionTag", { label, type: word(`types.${region.dataset.wcType ?? "text"}`) });
		tag.hidden = false;
		place(tag, region.getBoundingClientRect(), 2, "above");
	}

	function hideTag(): void {
		tag.hidden = true;
	}

	function showProblem(region: HTMLElement): void {
		const text = problems.get(region);
		problem.hidden = !text;
		if (!text) return;
		problem.textContent = text;
		place(problem, region.getBoundingClientRect(), 6, "below");
	}

	// ---------------------------------------------------------------------------------------------
	// The floating toolbar for rich text

	function buildToolbar(): HTMLElement {
		const tools: [string, () => void][] = [
			["bold", () => exec("bold")],
			["italic", () => exec("italic")],
			["link", () => openLinkForm()],
			["bulletList", () => exec("insertUnorderedList")],
			["numberedList", () => exec("insertOrderedList")],
			[
				"clearFormatting",
				() => {
					exec("removeFormat");
					exec("unlink");
				},
			],
		];
		const strip = el("div", {
			class: "toolbar",
			role: "toolbar",
			"aria-label": word("formatting"),
			"aria-orientation": "horizontal",
		});
		const buttons: HTMLButtonElement[] = [];
		for (const [name, act] of tools) {
			const tool = button(
				{
					class: "tool",
					"aria-label": word(name),
					tabindex: buttons.length === 0 ? "0" : "-1",
					"data-tool": name,
					...(name === "bold" || name === "italic" ? { "aria-pressed": "false" } : {}),
				},
				icon(name),
			);
			tool.addEventListener("click", act);
			buttons.push(tool);
			strip.append(tool);
		}
		strip.append(el("span", { class: "tool-divider", "aria-hidden": "true" }));
		const undo = button({ class: "tool", "aria-label": word("undoTyping"), tabindex: "-1" }, icon("undo"));
		undo.addEventListener("click", () => exec("undo"));
		const done = button({ class: "done", tabindex: "-1" }, word("done"));
		done.addEventListener("click", (event) => {
			const region = current;
			if (!region) return;
			void save(region);
			toolbarDismissed = true;
			hideToolbar();
			// From the keyboard, focus goes back to the text; with a pointer, editing ends there.
			if ((event as MouseEvent).detail === 0) region.focus();
			else region.blur();
		});
		buttons.push(undo, done);
		strip.append(undo, done);

		linkInput = el("input", { id: "wc-link-address", type: "url", class: "link-input", autocomplete: "off" });
		const apply = button({ class: "done" }, word("linkApply"));
		const remove = button({ class: "secondary small" }, word("linkRemove"));
		linkForm = el(
			"div",
			{ class: "link-form", hidden: "" },
			el("label", { for: "wc-link-address", class: "sr-only" }, word("linkAddress")),
			linkInput,
			apply,
			remove,
		);
		const applyLink = () => {
			const address = linkInput.value.trim();
			closeLinkForm();
			if (address) exec("createLink", address);
		};
		apply.addEventListener("click", applyLink);
		remove.addEventListener("click", () => {
			closeLinkForm();
			exec("unlink");
		});
		linkInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				applyLink();
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeLinkForm();
				backToText();
			}
		});

		const wrapper = el("div", { class: "toolbar-wrap", hidden: "" }, strip, linkForm);
		wrapper.addEventListener("mousedown", (event) => {
			// Keeps the text's selection while a tool is pressed.
			if (event.target !== linkInput) event.preventDefault();
		});
		strip.addEventListener("keydown", (event) => {
			const at = buttons.indexOf(root.activeElement as HTMLButtonElement);
			let next = -1;
			if (event.key === "ArrowRight") next = (at + 1) % buttons.length;
			else if (event.key === "ArrowLeft") next = (at - 1 + buttons.length) % buttons.length;
			else if (event.key === "Home") next = 0;
			else if (event.key === "End") next = buttons.length - 1;
			else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				backToText();
				return;
			} else return;
			event.preventDefault();
			for (const [index, tool] of buttons.entries()) tool.setAttribute("tabindex", index === next ? "0" : "-1");
			buttons[next]?.focus();
		});
		wrapper.addEventListener("focusout", (event) => {
			const next = (event as FocusEvent).relatedTarget;
			if (next instanceof Node && (wrapper.contains(next) || next === current)) return;
			if (current && next !== current) {
				const left = current;
				current = null;
				hideTag();
				hideToolbar();
				void save(left);
			}
		});
		return wrapper;
	}

	function showToolbar(region: HTMLElement): void {
		if (!editing || ended) return;
		toolbar.hidden = false;
		updatePressed();
		place(toolbar, region.getBoundingClientRect(), (tag.hidden ? 0 : tag.offsetHeight) + 6, "above");
	}

	function hideToolbar(): void {
		toolbar.hidden = true;
		closeLinkForm();
	}

	function updatePressed(): void {
		for (const name of ["bold", "italic"]) {
			let on = false;
			try {
				on = doc.queryCommandState(name);
			} catch {
				on = false;
			}
			toolbar.querySelector(`[data-tool="${name}"]`)?.setAttribute("aria-pressed", String(on));
		}
	}

	/** Keeps the selection in the text being edited, for the toolbar's tools to act on. */
	function rememberSelection(): void {
		const chosen = doc.getSelection();
		const range = chosen?.rangeCount ? chosen.getRangeAt(0) : undefined;
		if (range && current?.contains(range.commonAncestorContainer)) selection = range.cloneRange();
	}

	/** Runs an editing command on the text being edited, its selection put back first. */
	function exec(command: string, value?: string): void {
		const region = current;
		if (!region) return;
		backToText();
		doc.execCommand(command, false, value);
		updatePressed();
	}

	function backToText(): void {
		const region = current;
		if (!region) return;
		region.focus();
		const range = selection;
		const chosen = doc.getSelection();
		if (range && chosen && region.contains(range.commonAncestorContainer)) {
			chosen.removeAllRanges();
			chosen.addRange(range);
		}
	}

	function openLinkForm(): void {
		const anchor = doc.getSelection()?.anchorNode;
		const existing = anchor?.parentElement?.closest("a");
		linkInput.value = existing?.getAttribute("href") ?? "";
		linkForm.hidden = false;
		linkInput.focus();
	}

	function closeLinkForm(): void {
		linkForm.hidden = true;
	}

	// ---------------------------------------------------------------------------------------------
	// When Edit mode ends (signed out of the admin, access lost, 8 hours)

	function end(): void {
		if (ended) return;
		ended = true;
		editing = false;
		if (!state) return;
		applyMode();
		renderStatus();
		closePopup(false);
		announce(word("ended"));
	}
}
