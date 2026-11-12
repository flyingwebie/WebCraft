import type { componentScriptSettings } from "../../ui/builder/component-script-settings.ts";
import type { renderedRanges } from "../../ui/builder/rendered-ranges.ts";
/** What Code mode's script is given when it is made: the address of its own stylesheet. */
export type CodeModeConfig = { styles: string; panels: string };

/**
 * Code mode's panels (ADR 0016): WebCraft's own script on a page in Code mode, loaded only there (a
 * page in Content editing never loads it). It is served as a file from the Site's domain, made of
 * this function's source text and its config (`assets.ts` beside the editing bar's), so the function
 * must use nothing from outside itself.
 *
 * Clicking an element of the page (every element carries `data-wc-code`, where it comes from) opens
 * its Template or Component in the HTML panel, its Classes and the Site CSS in the CSS panel (the
 * editor's shared panel, mounted by the live panels module into this script's CSS panel), and the
 * page's and the Site's scripts in the JS panel, below the page. The page previews HTML and CSS as
 * Staff type (rendered by the server, never saved); each panel saves to the Draft only when asked,
 * and a save over a Draft someone changed meanwhile offers to reload it or overwrite it. Scripts run
 * only when Staff press Run (or load the page again), their errors shown in the console. Everything
 * draws in a shadow root, styled by its own stylesheet file: nothing inline.
 */
export function codeMode(
	config: CodeModeConfig,
	makeScriptSettings: typeof componentScriptSettings,
	rangesOf: typeof renderedRanges,
): void {
	type Words = { [key: string]: string | Words };
	type Answer = { ok: true; data: unknown } | { ok: false; code: string; data: Record<string, unknown> };
	type Problem = { line: number; column: number; message: string };
	type SourceKind = "entryTemplate" | "archiveTemplate" | "searchTemplate" | "siteTemplate" | "component";
	type Opened = {
		source: { kind: SourceKind; id: string | null; name: string | null; editable: boolean };
		ref: string;
		markup: string;
		version: string | null;
		element: { id: string; tag: string } | null;
		breadcrumb: { label: string | null; kind: SourceKind; ref: string }[];
		path: { id: string; label: string }[];
		usage: { pages: number } | null;
		suggestions: {
			values: { path: string; label: string | null; type: string; group: string; sample?: string }[];
			components: { name: string; props: { key: string; label: string; required: boolean }[] }[];
			commands: { name: string; block: boolean; snippet: string }[];
			presets: { id: string; snippet: string }[];
			loops: { name: string }[];
			classes: { name: string; utility: boolean }[];
		};
	};
	type CssTarget =
		| { kind: "class"; classId: string; part: "styles" }
		| { kind: "class"; classId: string; part: "css" }
		| { kind: "class"; classId: string; part: "breakpoint"; breakpointId: string }
		| { kind: "site" };
	type Script = { code: string; version: string | null; src: string | null };
	/** The Component tab: the selected Placement's Component and its Component script's Draft. */
	type ComponentScript = Script & {
		componentId: string;
		name: string;
		editable: boolean;
		pages: number;
		consentCategory: string;
		libraryIds: string[];
		libraries: { id: string; name: string }[];
		runtime: string;
	};
	type Scripts = {
		site: Script;
		page: (Script & { entryId: string }) | null;
		component?: ComponentScript | null;
	};
	type ScriptKind = "page" | "site" | "component";
	type Language = "markup" | "js";
	type Suggestion = {
		group: string;
		label: string;
		detail?: string;
		/** The text replacing `from` to the caret; `$0` marks where the caret goes. */
		insert: string;
		swatch?: string;
		run?: () => Promise<void>;
	};
	type Context = { from: number; to: number; items: Suggestion[] };
	type Editor = {
		root: HTMLElement;
		area: HTMLTextAreaElement;
		get(): string;
		set(text: string, keepCaret?: boolean): void;
		problems(lines: readonly number[]): void;
		mark(line: number | null, through?: number): void;
		reveal(offset: number): void;
		readOnly(on: boolean): void;
		/** Inserts text in place of what is selected, as typing would (it can be undone). */
		insert(text: string, from?: number, to?: number): void;
	};
	type Panel = "html" | "css" | "js";

	let inspectorRef: string | undefined;
	let openBuilderButton: HTMLButtonElement;
	let openingBuilder = false;
	let inputRevision = 0;
	let panelsAdapter:
		| {
				select(ref: string | null): void;
				hover(ref: string | null): void;
				refresh(): void;
				save(): Promise<boolean>;
				depart(): Promise<boolean>;
				markup(ref: string): Promise<string | null>;
		  }
		| undefined;
	const win = window;
	const doc = document;
	// Kept now, before any Site script runs (this script runs before them, after the editing bar's).
	const send = win.fetch.bind(win);
	const encode = JSON.stringify;
	const later = win.setTimeout.bind(win);
	const cancel = win.clearTimeout.bind(win);
	const parser = new DOMParser();
	const nativeConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
	const token = doc.querySelector('meta[name="webcraft-edit-token"]')?.getAttribute("content") ?? "";
	const path = win.location.pathname;
	const SVG = "http://www.w3.org/2000/svg";
	const PANEL_KEY = "webcraft-code-panels";
	/**
	 * Which script the JS panel opens at, when the editing bar's notice about a failed script asked:
	 * `site`, `page` or `component:<id>`.
	 */
	const CODE_SCRIPT_KEY = "webcraft-code-script";
	const ICONS: Record<string, string[]> = {
		code: ["m18 16 4-4-4-4", "m6 8-4 4 4 4", "m14.5 4-5 16"],
		brush: [
			"m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08",
			"M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z",
		],
		braces: [
			"M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1",
			"M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
		],
		warning: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
		chevron: ["m9 18 6-6-6-6"],
		collapse: ["m18 15-6-6-6 6"],
		expand: ["m6 9 6 6 6-6"],
		play: ["M6 3l14 9-14 9z"],
		check: ["M20 6 9 17l-5-5"],
		x: ["M18 6 6 18", "m6 6 12 12"],
	};
	/** Elements whose content Format may put on lines of its own: block containers. */
	const CONTAINERS = new Set(
		"address article aside blockquote details dialog div dl fieldset figure footer form header hgroup li main menu nav ol search section ul".split(
			" ",
		),
	);
	/** Elements a browser lays out as blocks by default: whitespace next to them never shows. */
	const BLOCK = new Set([...CONTAINERS, ..."p h1 h2 h3 h4 h5 h6 hr pre table figcaption dd dt".split(" ")]);
	/** Elements with no end tag, as HTML reads them. */
	const VOID = new Set([
		"area",
		"base",
		"br",
		"col",
		"embed",
		"hr",
		"img",
		"input",
		"link",
		"meta",
		"source",
		"track",
		"wbr",
	]);
	const JS_KEYWORDS = new Set(
		"const let var function return if else for while do switch case break continue new class extends import export from async await try catch finally throw typeof instanceof in of this null undefined true false default delete void yield".split(
			" ",
		),
	);

	let words: Words = {};
	let host: HTMLElement;
	let root: ShadowRoot;
	let live: HTMLElement;
	let shell: HTMLElement;
	let breadcrumb: HTMLElement;
	let usage: HTMLElement;
	let statusLine: HTMLElement;
	let selectedBox: HTMLElement;
	let selectedLabel: HTMLElement;
	let hoverBox: HTMLElement;
	let hoveredRef: string | null = null;
	const panelReady = new Map<string, boolean>();
	let showInsertion: (() => void) | null = null;
	let insertBox: HTMLElement;
	let dialog: HTMLElement;
	let listbox: HTMLElement;
	let toggleButton: HTMLButtonElement;
	let shown = true;

	// The HTML panel
	let html: Editor;
	let htmlTitle: HTMLElement;
	let htmlSave: HTMLButtonElement;
	let htmlFormat: HTMLButtonElement;
	let htmlProblems: HTMLElement;
	let checksList: HTMLElement;
	let checksPanel: HTMLDetailsElement;
	let checksSummary: HTMLElement;
	let qualityChecks: { check: string; at: string; detail?: string }[] = [];
	const showChecks = () => {
		checksSummary.textContent = `${word("checks.heading")} (${qualityChecks.length})`;
		checksList.replaceChildren(
			...(!checksPanel.open
				? []
				: qualityChecks.length
					? qualityChecks.map((check) => {
							const label = word(`checks.${check.check}`) + (check.detail ? ` (${check.detail})` : "");
							const item = el("li", {}, label);
							if (/^(site|content)([/#]|$)/.test(check.at)) {
								const link = button({ class: "problem-link" }, word("checks.open"));
								link.addEventListener("click", () => void select(check.at.replace(/(?:\.\d+)+$/, "")));
								item.append(link);
							}
							return item;
						})
					: [el("li", {}, word("checks.empty"))]),
		);
	};
	let opened: Opened | null = null;
	let savedMarkup = "";
	let selectedRef: string | null = null;
	let openRun = 0;
	let markupInputRun = 0;
	type Locations = { key: string; start: number; end: number }[];
	let located: { ref: string; text: string; locations: Locations; pending: Promise<void> } | undefined;
	type HoverContext = { ref: string; markup: string; label: string; locations: Locations };
	let hoverContext: HoverContext | undefined;

	/** Metadata belongs to the exact authored text. It never supplies content or changes selection. */
	function locateMarkup(): Promise<void> {
		if (!opened) return Promise.resolve();
		const ref = opened.ref;
		const text = html.get();
		if (located?.ref === ref && located.text === text) return located.pending;
		const next = { ref, text, locations: [] as Locations, pending: Promise.resolve() };
		located = next;
		next.pending = call("code/editorRead", { path, ref, markup: text }).then((answer) => {
			if (located !== next || opened?.ref !== ref || html.get() !== text || !answer.ok) return;
			next.locations = (answer.data as { locations: Locations }).locations;
			markSelection();
			setHover(hoveredRef);
		});
		return next.pending;
	}

	function locationOf(ref: string | null): { start: number; end: number } | undefined {
		if (!ref || !opened || located?.ref !== opened.ref || located.text !== html.get()) return;
		const [source, key = ""] = ref.split("#");
		return source === opened.ref ? located.locations.find((range) => range.key === key) : undefined;
	}

	function refAt(offset: number): string | null {
		if (!opened || located?.ref !== opened.ref || located.text !== html.get()) return null;
		const found = located.locations
			.filter((range) => range.start <= offset && offset < range.end)
			.sort((a, b) => a.end - a.start - (b.end - b.start))[0];
		return found ? `${opened.ref}#${found.key}` : null;
	}

	function markSelection(reveal = false): void {
		const range = locationOf(selectedRef);
		if (range) {
			if (reveal) html.reveal(range.start);
			html.mark(lineOf(html.get(), range.start));
		} else if (inspectorRef && selectedRef === inspectorRef) html.mark(1, html.get().split("\n").length);
		else html.mark(null);
	}

	/** Derived row addresses are local selection metadata, not stored element ids. */
	function requestRef(ref: string | null): string | null {
		return ref?.includes("#@") ? (ref.split("#")[0] ?? null) : ref;
	}

	// The CSS panel: the editor's shared panel draws in `cssHost`, and asks the page to preview what it has unsaved.
	let cssHost: HTMLElement;
	let pendingCss: { target: CssTarget; text: string } | null = null;

	// The JS panel
	let jsEditor: Editor;
	let jsTitle: HTMLElement;
	let jsSave: HTMLButtonElement;
	let jsRun: HTMLButtonElement;
	let jsPageTab: HTMLButtonElement;
	let jsSiteTab: HTMLButtonElement;
	let jsComponentTab: HTMLButtonElement;
	let jsNote: HTMLElement;
	let jsUsage: HTMLElement;
	let jsSettings: HTMLElement;
	let scriptSettings: ReturnType<typeof componentScriptSettings>;
	let consoleList: HTMLElement;
	let scripts: Scripts | null = null;
	let jsKind: ScriptKind = "page";
	let jsSaved = "";
	let componentScriptLoadRun = 0;
	/** The Component tab's settings as last saved (its Consent category and Libraries), to tell a change. */
	let jsSettingsSaved = "";

	/** Buttons whose action is running: pressing one again waits for it, and it keeps focus meanwhile. */
	const busy = new Set<HTMLButtonElement>();
	let previewTimer = 0;
	let previewRun = 0;
	let caretTimer = 0;
	let previewSheet: CSSStyleSheet | null = null;
	let lastStylesheet = "";
	const status: Record<Panel, string> = { html: "", css: "", js: "" };
	let savedNote = "";
	let suggestion: { editor: Editor; context: Context; active: number } | null = null;
	let ids = 0;
	const pending: string[] = [];

	captureConsole();
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
			const data = (await response.json().catch(() => ({}))) as { code?: string; data?: Record<string, unknown> };
			if (response.ok) return { ok: true, data };
			return { ok: false, code: data.code ?? "generic", data: data.data ?? {} };
		} catch {
			return { ok: false, code: "generic", data: {} };
		}
	}

	async function start(): Promise<void> {
		const state = await call("state", { path });
		if (!state.ok) return;
		words = ((state.data as { words?: Words }).words?.codeMode as Words | undefined) ?? {};
		build();
		for (const line of pending.splice(0)) logLine("error", line);
		const selectionHash = new URLSearchParams(win.location.hash.slice(1)).get("wc-selection");
		if (selectionHash) win.history.replaceState(null, "", win.location.pathname + win.location.search);
		await Promise.all([open(selectionHash), loadScripts()]);
		const module = await import(config.panels);
		panelsAdapter = module.mount({
			root,
			cssHost,
			edited: () => inputRevision++,
			language: (state.data as { adminLanguage?: string }).adminLanguage === "it" ? "it" : "en",
			async call(action: string, body: object) {
				const response = await call(action, { path, ...body });
				if (!response.ok) throw Object.assign(new Error(response.code), { code: response.code, data: response.data });
				return response.data;
			},
			select: (ref: string, inspect?: string) => {
				inspectorRef = inspect;
				void select(ref, true);
			},
			changed(ref: string, markup: string, preserveAuthored = false) {
				if (opened?.ref === ref && !preserveAuthored) {
					html.set(markup, true);
					savedMarkup = markup;
					markSelection();
					void locateMarkup();
					setDirty("html");
				}
				if (hoverContext?.ref === ref) {
					hoverContext = undefined;
					showHtmlHover();
				}
				schedulePreview();
			},
			refresh() {
				schedulePreview();
			},
			previewCss(change: { target: CssTarget; text: string } | null) {
				// The page renders again only when what it should show changes.
				if (encode(change) === encode(pendingCss)) return;
				pendingCss = change;
				schedulePreview();
			},
			ready(ref: string, editable: boolean) {
				panelReady.set(ref, editable);
				if (opened?.ref === ref) editorReady();
			},
			insertPreview(
				ref: string | null,
				where: string,
				context?: { ref: string; markup: string; offset: number; label: string },
			) {
				showInsertion = () => {
					root.querySelector(".insertion-context")?.remove();
					for (const line of root.querySelectorAll(".insert-line")) line.classList.remove("insert-line");
					const box = ref ? (pageBoundsFor(ref) ?? doc.querySelector("main")?.getBoundingClientRect()) : null;
					insertBox.hidden = !box;
					if (!box || !ref || !context) {
						insertBox.removeAttribute("data-insert-preview");
						return;
					}
					insertBox.style.left = `${box.left}px`;
					insertBox.style.top = `${box.bottom - (where === "inside" ? 4 : 0)}px`;
					insertBox.style.width = `${box.width}px`;
					insertBox.style.height = "2px";
					insertBox.setAttribute("data-insert-preview", where);
					const at = Math.max(0, context.offset - (where === "after" ? 1 : 0));
					if (context.ref === opened?.ref && context.markup === html.get()) {
						html.root.querySelectorAll(".line")[lineOf(context.markup, at) - 1]?.classList.add("insert-line");
					} else {
						// A Placement keeps its Component open; show its owning Template's insertion point alongside it.
						const line = context.markup.split("\n")[lineOf(context.markup, at) - 1] ?? "";
						html.root.append(
							el(
								"pre",
								{ class: "source-context insertion-context insert-line", "aria-live": "polite" },
								`${context.label}\n${line}`,
							),
						);
					}
				};
				showInsertion();
			},
			hover: setHover,
		});
		panelsAdapter?.select(selectedRef ?? opened?.ref ?? null);
		editorReady();
		openAskedScript();
		await preview();
	}

	/**
	 * When the editing bar's notice about a failed Site script brought Staff here, the JS panel opens
	 * at that script (`site` or `page`), its editor focused.
	 */
	function openAskedScript(): void {
		let asked: string | null = null;
		try {
			asked = win.sessionStorage.getItem(CODE_SCRIPT_KEY);
			win.sessionStorage.removeItem(CODE_SCRIPT_KEY);
		} catch {
			return;
		}
		if (asked?.startsWith("component:")) {
			// A Component's script: a Placement of it on the page is selected, then its tab shown.
			const id = asked.slice("component:".length);
			const root = [...doc.querySelectorAll("[data-wc-component][data-wc-code]")].find((element) =>
				(element.getAttribute("data-wc-component") ?? "").split(" ").includes(id),
			);
			const ref = root?.getAttribute("data-wc-code");
			if (!ref) return;
			showPanels(true);
			void select(ref).then(async () => {
				await loadComponentScript(ref);
				switchScript("component");
				jsEditor.area.focus();
			});
			return;
		}
		if (asked !== "site" && asked !== "page") return;
		showPanels(true);
		switchScript(asked);
		jsEditor.area.focus();
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

	function newId(stem: string): string {
		ids++;
		return `wc-code-${stem}-${ids}`;
	}

	function announce(text: string): void {
		live.textContent = "";
		later(() => {
			live.textContent = text;
		}, 60);
	}

	function errorText(code: string): string {
		const text = word(`errors.${code}`);
		return text === `errors.${code}` ? word("errors.generic") : text;
	}

	/** How a Template or Component is named: its kind in the person's words. */
	function sourceName(kind: SourceKind, name: string | null): string {
		if (kind === "siteTemplate") return word("siteTemplate");
		if (kind === "entryTemplate" || kind === "archiveTemplate") return word(kind, { name: name ?? "" });
		if (kind === "searchTemplate") return word("searchTemplate");
		return word("component", { name: name ?? "" });
	}

	// ---------------------------------------------------------------------------------------------
	// The panels

	async function openBuilder(): Promise<void> {
		if (
			!opened?.source.editable ||
			!panelsAdapter ||
			panelReady.get(opened.ref) !== true ||
			busy.size ||
			openingBuilder
		)
			return;
		openingBuilder = true;
		openBuilderButton.disabled = true;
		try {
			const revision = inputRevision;
			const sourceBefore = opened.ref;
			if (!(await panelsAdapter.depart())) return;
			if (jsDirty() && !(await saveScript(undefined))) return;
			if (opened.ref !== sourceBefore || htmlDirty() || jsDirty()) return;
			const ref = selectedRef ?? opened.ref;
			const answer = await call("code/editor", { path, ref: requestRef(ref) });
			if (!answer.ok) return;
			const source = answer.data as {
				editable: boolean;
				siteId: string;
				adminOrigin: string;
				previewEntryId: string | null;
				target: { kind: string; componentId?: string; postTypeId?: string };
			};
			if (
				!source.editable ||
				inputRevision !== revision ||
				opened.ref !== sourceBefore ||
				(selectedRef ?? opened.ref) !== ref ||
				htmlDirty() ||
				jsDirty()
			)
				return;
			const target = source.target;
			const kind = target.kind.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
			const id = target.componentId ?? target.postTypeId;
			const url = new URL(`/builder/${source.siteId}/${kind}${id ? `/${id}` : ""}`, source.adminOrigin);
			const [sourceRef, key] = ref.split("#");
			if (key) url.searchParams.set("element", key);
			if (source.previewEntryId) url.searchParams.set("entry", source.previewEntryId);
			url.searchParams.set("returnPath", path);
			url.searchParams.set("returnTitle", doc.title.split(" · ")[0] ?? path);
			url.searchParams.set("returnRef", sourceRef ?? opened.ref);
			win.location.assign(url.href);
		} finally {
			openingBuilder = false;
			editorReady();
		}
	}

	function build(): void {
		host = doc.createElement("webcraft-code-mode");
		root = host.attachShadow({ mode: "open" });
		// CSS and Inspector inputs can change while the last navigation request is in flight.
		for (const event of ["input", "change"]) root.addEventListener(event, () => inputRevision++, true);
		live = el("p", { role: "status", class: "sr-only" });
		breadcrumb = el("ol", { class: "crumbs" });
		usage = el("p", { class: "usage", hidden: "" });
		toggleButton = button(
			{ class: "icon-button", "aria-expanded": "true" },
			icon("collapse"),
			el("span", { class: "sr-only" }, word("hide")),
		);
		toggleButton.addEventListener("click", () => showPanels(!shown));
		statusLine = el("p", { class: "status-text" });
		listbox = el("div", {
			class: "suggest",
			role: "listbox",
			id: newId("suggest"),
			"aria-label": word("suggestions"),
			hidden: "",
		});
		listbox.addEventListener("mousedown", (event) => event.preventDefault());

		openBuilderButton = button({ class: "secondary", disabled: "" }, word("openBuilder"));
		openBuilderButton.addEventListener("click", () => void openBuilder());
		const panels = el("div", { class: "panels", id: newId("panels") });
		panels.append(buildHtmlPanel(), buildCssPanel(), buildJsPanel());
		toggleButton.setAttribute("aria-controls", panels.id);
		shell = el(
			"section",
			{ class: "code-mode", "aria-label": word("label") },
			el(
				"div",
				{ class: "topline" },
				el("span", { class: "badge" }, word("staffOnly")),
				el("nav", { class: "crumbs-nav", "aria-label": word("whereFrom") }, breadcrumb),
				usage,
				openBuilderButton,
				toggleButton,
			),
			panels,
			el(
				"div",
				{ class: "statusline" },
				statusLine,
				el("p", { class: "hint" }, word("clickHint"), " · ", word("keysHint")),
			),
			live,
		);
		selectedLabel = el("span", { class: "outline-label" });
		selectedBox = el("div", { class: "outline selected", "aria-hidden": "true", hidden: "" }, selectedLabel);
		hoverBox = el("div", { class: "outline hover", "aria-hidden": "true", hidden: "" });
		insertBox = el("div", { class: "outline insert", "aria-hidden": "true", hidden: "" });
		dialog = el("div", { class: "dialog-backdrop", hidden: "" });
		// The suggestions and the prompts float above everything, but belong to Code mode's region.
		shell.append(listbox, dialog);
		root.append(el("link", { rel: "stylesheet", href: config.styles }), selectedBox, hoverBox, insertBox, shell);
		doc.body.append(host);
		doc.documentElement.classList.add("wc-code");
		try {
			if (win.localStorage.getItem(PANEL_KEY) === "hidden") showPanels(false);
		} catch {
			// Without storage the panels show each time.
		}

		// Selecting on the page: a click opens what the element comes from, and never follows a link.
		doc.addEventListener(
			"click",
			(event) => {
				const ref = pageRef(event);
				if (!ref) return;
				event.preventDefault();
				event.stopPropagation();
				void select(ref);
			},
			true,
		);
		doc.addEventListener(
			"submit",
			(event) => {
				if (!event.composedPath().includes(host)) event.preventDefault();
			},
			true,
		);
		doc.addEventListener("mouseover", (event) => {
			if (event.composedPath().includes(host)) return;
			setHover(pageRef(event));
		});
		doc.addEventListener("mouseleave", () => {
			setHover(null);
		});
		const reposition = () => {
			const target = selectedRef ? pageBoundsFor(selectedRef) : null;
			if (target) outline(selectedBox, target);
			else selectedBox.hidden = true;
			hoverBox.hidden = true;
		};
		win.addEventListener("scroll", reposition, { passive: true, capture: true });
		win.addEventListener("resize", reposition, { passive: true });
		// The panels never cover what has focus on the page.
		doc.addEventListener("focusin", (event) => {
			const target = event.target;
			if (!(target instanceof Element) || target === host || !shown) return;
			const bottom = target.getBoundingClientRect().bottom;
			const top = shell.getBoundingClientRect().top - 8;
			if (bottom > top) win.scrollBy({ top: bottom - top, behavior: "instant" });
		});
		root.addEventListener("keydown", (event) => {
			const key = (event as KeyboardEvent).key;
			if (key === "Escape" && !dialog.hidden) {
				event.preventDefault();
				closeDialog();
			}
		});
		setStatus();
	}

	function showPanels(on: boolean): void {
		shown = on;
		shell.classList.toggle("collapsed", !on);
		doc.documentElement.classList.toggle("wc-code-collapsed", !on);
		toggleButton.setAttribute("aria-expanded", String(on));
		toggleButton.replaceChildren(
			icon(on ? "collapse" : "expand"),
			el("span", { class: "sr-only" }, word(on ? "hide" : "show")),
		);
		try {
			win.localStorage.setItem(PANEL_KEY, on ? "shown" : "hidden");
		} catch {
			// Not kept; that's all.
		}
	}

	function panelHeader(
		id: string,
		name: string,
		iconName: string,
		title: HTMLElement,
		...tools: (Node | string)[]
	): HTMLElement {
		return el(
			"div",
			{ class: "panel-head" },
			el("h2", { id }, icon(iconName), el("span", { class: "panel-name" }, name), title),
			el("div", { class: "panel-tools" }, ...tools),
		);
	}

	function buildHtmlPanel(): HTMLElement {
		const heading = newId("html");
		htmlTitle = el("span", { class: "panel-sub" });
		htmlFormat = button({ class: "small secondary", title: word("formatHint") }, word("format"));
		htmlFormat.addEventListener("click", () => format());
		htmlSave = button({ class: "small primary" }, word("save"));
		htmlSave.addEventListener("click", () => void saveHtml(null));
		htmlProblems = el("ul", {
			class: "problems",
			"aria-label": word("problemList", { panel: word("html") }),
			hidden: "",
		});
		checksList = el("ul", {});
		checksSummary = el("summary", {}, word("checks.heading"));
		const checks = el(
			"details",
			{ class: "quality-checks" },
			checksSummary,
			el("p", {}, word("checks.intro")),
			checksList,
		);
		checksPanel = checks;
		checks.addEventListener("toggle", showChecks);
		html = editor({
			language: "markup",
			label: word("html"),
			onInput: () => {
				markupInputRun++;
				void locateMarkup();
				setDirty("html");
				schedulePreview();
			},
			onCaret: (offset) => {
				cancel(caretTimer);
				caretTimer = later(() => caretMoved(offset), 250);
			},
			suggest: markupSuggestions,
			save: () => void saveHtml(null),
		});
		return el(
			"section",
			{ class: "panel", "aria-labelledby": heading },
			panelHeader(heading, word("html"), "code", htmlTitle, htmlFormat, htmlSave),
			html.root,
			htmlProblems,
			checks,
		);
	}

	function buildCssPanel(): HTMLElement {
		const heading = newId("css");
		cssHost = el("div", { class: "css-host editor-panels dark" });
		return el(
			"section",
			{ class: "panel", "aria-labelledby": heading },
			panelHeader(heading, word("css"), "brush", el("span", { class: "panel-sub" })),
			cssHost,
		);
	}

	function buildJsPanel(): HTMLElement {
		const heading = newId("js");
		jsTitle = el("span", { class: "panel-sub" });
		jsPageTab = button({ class: "segment", "aria-pressed": "true" }, word("pageTab"));
		jsSiteTab = button({ class: "segment", "aria-pressed": "false" }, word("siteTab"));
		jsComponentTab = button({ class: "segment", "aria-pressed": "false", hidden: "" }, word("componentTab"));
		jsPageTab.addEventListener("click", () => switchScript("page"));
		jsSiteTab.addEventListener("click", () => switchScript("site"));
		jsComponentTab.addEventListener("click", () => switchScript("component"));
		jsSave = button({ class: "small secondary" }, word("save"));
		jsSave.addEventListener("click", () => void saveScript(null));
		jsRun = button({ class: "small primary", title: word("runHint") }, icon("play"), word("run"));
		jsRun.addEventListener("click", () => void run());
		jsNote = el("p", { class: "note", hidden: "" });
		jsUsage = el("p", { class: "usage", hidden: "" });
		scriptSettings = makeScriptSettings({ document: doc, word, changed: () => setDirty("js") });
		jsSettings = scriptSettings.root;
		jsSettings.hidden = true;
		jsEditor = editor({
			language: "js",
			label: word("js"),
			onInput: () => setDirty("js"),
			onCaret: () => undefined,
			suggest: () => null,
			save: () => void saveScript(null),
		});
		const clear = button({ class: "link-button" }, word("clear"));
		consoleList = el("ol", { class: "console-lines" });
		clear.addEventListener("click", () => consoleList.replaceChildren());
		const consoleHeading = newId("console");
		return el(
			"section",
			{ class: "panel", "aria-labelledby": heading },
			panelHeader(
				heading,
				word("js"),
				"braces",
				jsTitle,
				el(
					"div",
					{ class: "segments", role: "group", "aria-label": word("scriptSource") },
					jsPageTab,
					jsSiteTab,
					jsComponentTab,
				),
				jsSave,
				jsRun,
			),
			jsUsage,
			jsSettings,
			jsNote,
			jsEditor.root,
			el(
				"section",
				{ class: "console", "aria-labelledby": consoleHeading },
				el("div", { class: "console-head" }, el("h3", { id: consoleHeading }, word("console")), clear),
				el("div", { class: "console-log", tabindex: "0", role: "log", "aria-labelledby": consoleHeading }, consoleList),
				el("p", { class: "console-empty" }, word("consoleEmpty")),
			),
		);
	}

	// ---------------------------------------------------------------------------------------------
	// The page: what each element comes from

	function pageElement(event: Event): Element | null {
		for (const node of event.composedPath()) {
			if (node === host) return null;
			if (node instanceof Element && node.hasAttribute("data-wc-code")) return node;
		}
		return null;
	}

	/** Generated command output has no authored element id; its innermost rendered range owns it. */
	function pageRef(event: Event): string | null {
		if (event.composedPath().includes(host)) return null;
		const target = event.composedPath().find((node): node is Element => node instanceof Element);
		const element = pageElement(event);
		if (target && target !== element) {
			for (const { ref, range } of rangesOf(doc)) {
				if (!ref.endsWith("/0") && range.intersectsNode(target) && (!element || !range.isPointInRange(element, 0)))
					return ref;
			}
		}
		return element?.getAttribute("data-wc-code") ?? null;
	}

	function setHover(ref: string | null): void {
		hoveredRef = ref;
		const target = ref ? pageBoundsFor(ref) : null;
		if (target) {
			outline(hoverBox, target);
			hoverBox.dataset.hoverRef = ref ?? "";
		} else {
			hoverBox.hidden = true;
			delete hoverBox.dataset.hoverRef;
		}
		showHtmlHover();
		panelsAdapter?.hover(ref);
	}

	/** Another source's hover is a read-only excerpt, never a switch away from unfinished markup. */
	function showHtmlHover(): void {
		html.root.querySelector(".hover-context")?.remove();
		for (const line of html.root.querySelectorAll(".hovered")) line.classList.remove("hovered");
		const range = locationOf(hoveredRef);
		const [ref, key = ""] = (hoveredRef ?? "").split("#");
		if (range || !ref || !opened || ref === opened.ref) {
			hoverContext = undefined;
			if (range) html.root.querySelectorAll(".line")[lineOf(html.get(), range.start) - 1]?.classList.add("hovered");
			return;
		}
		if (hoverContext?.ref !== ref) {
			const next: HoverContext = { ref, markup: "", label: "", locations: [] };
			hoverContext = next;
			void readHoverContext(next);
			return;
		}
		const context = hoverContext;
		const found = context.locations.find((each) => each.key === key);
		if (!found) return;
		const line = context.markup.split("\n")[lineOf(context.markup, found.start) - 1] ?? "";
		html.root.append(
			el(
				"pre",
				{ class: "source-context hover-context", "aria-hidden": "true" },
				`${context.label}\n`,
				el("span", { class: "line hovered" }, line),
			),
		);
	}

	async function readHoverContext(context: HoverContext): Promise<void> {
		try {
			const answer = await call("code/open", { path, ref: context.ref });
			if (hoverContext !== context || !answer.ok) return;
			const source = answer.data as Opened;
			const markup = source.source.editable
				? ((await panelsAdapter?.markup(context.ref)) ?? source.markup)
				: source.markup;
			if (hoverContext !== context) return;
			const read = await call("code/editorRead", { path, ref: context.ref, markup });
			if (hoverContext !== context || !read.ok) return;
			context.markup = markup;
			context.label = sourceName(source.source.kind, source.source.name);
			context.locations = (read.data as { locations: Locations }).locations;
			showHtmlHover();
		} catch {
			// An unavailable source has no excerpt; the hovered row and rendered outline still apply.
		}
	}

	function pageElementFor(ref: string): Element | null {
		for (const candidate of doc.querySelectorAll("[data-wc-code]")) {
			if (candidate.getAttribute("data-wc-code") === ref) return candidate;
		}
		const placed = ref.replace("#", "/");
		return (
			[...doc.querySelectorAll("[data-wc-code]")].find((element) =>
				element.getAttribute("data-wc-code")?.startsWith(`${placed}#`),
			) ?? null
		);
	}

	/** A Placement can render several roots, including roots supplied by nested Components. */
	function pageBoundsFor(ref: string): DOMRect | null {
		if (ref.includes("#@")) {
			const rects = rangesOf(doc)
				.filter((each) => each.ref === ref)
				.flatMap(({ range }) => [...range.getClientRects()]);
			return boundsOf(rects);
		}
		const elements = [...doc.querySelectorAll("[data-wc-code]")];
		const exact = elements.filter((element) => element.getAttribute("data-wc-code") === ref);
		const placed = ref.replace("#", "/");
		const matches = exact.length
			? exact
			: elements.filter((element) => {
					const source = element.getAttribute("data-wc-code") ?? "";
					return source.startsWith(`${placed}#`) || source.startsWith(`${placed}/`);
				});
		const roots = matches.filter((element) => !matches.some((other) => other !== element && other.contains(element)));
		return boundsOf(roots.map((element) => element.getBoundingClientRect()));
	}

	function boundsOf(boxes: DOMRect[]): DOMRect | null {
		const rects = boxes.filter((rect) => rect.width > 0 && rect.height > 0);
		if (!rects.length) return null;
		const left = Math.min(...rects.map((rect) => rect.left));
		const top = Math.min(...rects.map((rect) => rect.top));
		return new DOMRect(
			left,
			top,
			Math.max(...rects.map((rect) => rect.right)) - left,
			Math.max(...rects.map((rect) => rect.bottom)) - top,
		);
	}

	function outline(box: HTMLElement, target: Element | DOMRect, label?: string): void {
		const rect = target instanceof Element ? target.getBoundingClientRect() : target;
		box.hidden = false;
		box.style.top = `${Math.round(rect.top)}px`;
		box.style.left = `${Math.round(rect.left)}px`;
		box.style.width = `${Math.round(rect.width)}px`;
		box.style.height = `${Math.round(rect.height)}px`;
		if (label !== undefined) selectedLabel.textContent = label;
	}

	/** Swaps the page's content for a freshly rendered one, keeping WebCraft's own parts. */
	function swapPage(htmlText: string): void {
		const fresh = parser.parseFromString(htmlText, "text/html");
		const bar = doc.querySelector("body > webcraft-edit-bar");
		const keep = new Set<Node>([host, ...(bar ? [bar] : [])]);
		for (const child of [...doc.body.childNodes]) if (!keep.has(child)) child.remove();
		const nodes = [...fresh.body.childNodes].map((node) => doc.importNode(node, true));
		const skip = nodes.find((node) => node instanceof Element && node.matches("a.wc-skip-link"));
		const rest = nodes.filter((node) => node !== skip);
		if (bar) bar.after(...rest);
		else host.before(...rest);
		if (skip) doc.body.prepend(skip);
		panelsAdapter?.refresh();
		const target = selectedRef ? pageBoundsFor(selectedRef) : null;
		if (target) outline(selectedBox, target);
		else selectedBox.hidden = true;
	}

	/** Shows a stylesheet the server built for a preview, in place of the page's own. */
	function applyStylesheet(text: string): void {
		if (text === lastStylesheet) return;
		lastStylesheet = text;
		try {
			previewSheet ??= new CSSStyleSheet();
			previewSheet.replaceSync(text);
			if (!doc.adoptedStyleSheets.includes(previewSheet)) {
				doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, previewSheet];
			}
			for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
				if (link.getAttribute("href")?.startsWith("/_webcraft/edit/css/")) link.disabled = true;
			}
		} catch {
			// A browser without constructed stylesheets keeps the page's stylesheet as loaded.
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Selecting: the HTML panel

	async function select(ref: string, fromPanels = false): Promise<void> {
		cancel(caretTimer);
		if (!fromPanels) inspectorRef = undefined;
		if (!ref) return;
		const sourceRef = ref.split("#")[0] ?? "";
		if (opened && sourceRef !== opened.ref && html.get() !== savedMarkup) {
			const keep = await ask(word("unsavedTitle"), word("unsavedText", { name: currentName() }), [
				["keep", word("keepEditing"), "secondary"],
				["discard", word("discardAndOpen"), "danger"],
			]);
			if (keep !== "discard") return;
			await open(ref);
			// The page showed the discarded markup: it shows the Drafts again.
			await preview();
			return;
		}
		await open(ref, sourceRef === opened?.ref && htmlDirty());
	}

	function currentName(): string {
		return opened ? sourceName(opened.source.kind, opened.source.name) : "";
	}

	async function open(ref: string | null, keepText = false): Promise<void> {
		const run = ++openRun;
		const inputRun = markupInputRun;
		const answer = await call("code/open", { path, ref: requestRef(ref) });
		if (run !== openRun) return;
		if (!answer.ok) {
			setStatusText(errorText(answer.code));
			return;
		}
		const fresh = answer.data as Opened;
		const sameSource = opened?.ref === fresh.ref;
		if (!sameSource && inputRun !== markupInputRun) return;
		if (!sameSource && fresh.source.editable && panelsAdapter) {
			try {
				const markup = await panelsAdapter.markup(fresh.ref);
				if (run !== openRun || inputRun !== markupInputRun || markup === null) return;
				fresh.markup = markup;
			} catch (failure) {
				if (run === openRun) setStatusText(errorText((failure as { code?: string }).code ?? "generic"));
				return;
			}
		}
		opened = fresh;
		selectedRef = ref?.includes("#@")
			? ref
			: fresh.element
				? `${fresh.ref}#${fresh.element.id}`
				: (inspectorRef ?? null);
		// Once connected, the shared Draft owns this source's HTML; selection reads supply metadata only.
		if (!sameSource || (!panelsAdapter && !keepText)) {
			savedMarkup = fresh.markup;
			html.set(fresh.markup);
			showProblems("html", []);
			setDirty("html");
		}
		editorReady();
		htmlTitle.textContent = sourceName(fresh.source.kind, fresh.source.name);

		html.area.setAttribute("aria-label", word("htmlOf", { name: currentName() }));
		renderBreadcrumb();
		renderUsage();
		const target = selectedRef ? pageBoundsFor(selectedRef) : null;
		if (target) {
			const last = fresh.path.at(-1)?.label ?? "";
			outline(selectedBox, target, `${last} · ${currentName()}`);
		} else selectedBox.hidden = true;
		markSelection(true);
		void locateMarkup();
		void loadComponentScript(selectedRef ?? fresh.ref);
		if (!fresh.source.editable) setStatusText(word("readOnly", { name: currentName() }));
		html.area.dataset.editorRef = fresh.ref;
		if (!sameSource) html.area.dispatchEvent(new Event("editor-source"));
		panelsAdapter?.select(inspectorRef ?? selectedRef ?? fresh.ref);
	}

	function editorReady(): void {
		const editable = !!opened?.source.editable && panelReady.get(opened.ref) === true;
		html.root.setAttribute("aria-busy", String(!!opened?.source.editable && !editable));
		html.readOnly(!editable);
		htmlSave.disabled = !editable;
		openBuilderButton.disabled = !editable || !panelsAdapter || openingBuilder;
		htmlFormat.disabled = !editable;
	}

	function renderBreadcrumb(): void {
		const current = opened;
		if (!current) return;
		const items: HTMLElement[] = [];
		const steps = current.breadcrumb;
		for (const [index, step] of steps.entries()) {
			const name = sourceName(step.kind, step.label);
			const last = index === steps.length - 1 && current.path.length === 0;
			if (last || index === steps.length - 1) {
				const crumb = button({ class: "crumb" }, name);
				crumb.addEventListener("click", () => void select(step.ref));
				if (last) crumb.setAttribute("aria-current", "location");
				items.push(el("li", {}, crumb));
			} else {
				const crumb = button({ class: "crumb" }, name);
				crumb.addEventListener("click", () => void select(step.ref));
				items.push(el("li", {}, crumb));
			}
		}
		for (const [index, step] of current.path.entries()) {
			const crumb = button({ class: "crumb code" }, step.label);
			crumb.addEventListener("click", () => void select(`${current.ref}#${step.id}`));
			if (index === current.path.length - 1) crumb.setAttribute("aria-current", "location");
			items.push(el("li", {}, crumb));
		}
		breadcrumb.replaceChildren(...items);
	}

	function renderUsage(): void {
		const current = opened;
		if (current?.usage && current.source.kind === "component") {
			const name = current.source.name ?? "";
			const count = current.usage.pages;
			usage.replaceChildren(
				icon("warning"),
				count === 0
					? word("usedOnNone", { name })
					: count === 1
						? word("usedOnOne", { name })
						: word("usedOnOther", { name, count }),
			);
			usage.hidden = false;
		} else {
			usage.hidden = true;
			usage.replaceChildren();
		}
	}

	/** Use the parser's ranges for tags, Template commands, values and later branches alike. */
	async function caretMoved(offset: number): Promise<void> {
		if (root.activeElement !== html.area) return;
		const source = opened?.ref;
		const text = html.get();
		const run = ++openRun;
		await locateMarkup();
		if (run !== openRun || source !== opened?.ref || text !== html.get() || root.activeElement !== html.area) return;
		const ref = refAt(offset);
		if (!ref || ref === selectedRef) return;
		inspectorRef = undefined;
		selectedRef = ref;
		panelsAdapter?.select(ref);
		markSelection();
		const target = pageBoundsFor(ref);
		if (target) outline(selectedBox, target, currentName());
		else selectedBox.hidden = true;
		pageElementFor(ref)?.scrollIntoView({ block: "nearest" });
		if (html.get() === savedMarkup) void open(ref, true);
	}

	// ---------------------------------------------------------------------------------------------
	// Preview, save, format: the HTML panel, and the CSS panel's unsaved CSS on the page

	function htmlDirty(): boolean {
		return opened !== null && html.get() !== savedMarkup;
	}

	function schedulePreview(): void {
		cancel(previewTimer);
		previewTimer = later(() => void preview(), 350);
	}

	async function preview(): Promise<void> {
		const run = ++previewRun;
		const body: Record<string, unknown> = { path };
		if (opened && htmlDirty()) body.markup = { ref: opened.ref, text: html.get() };
		if (pendingCss) body.css = pendingCss;
		const answer = await call("code/preview", body);
		if (run !== previewRun) return;
		if (!answer.ok) {
			// CSS the Design system refuses is the CSS panel's to show, when it is saved.
			if (answer.code === "TEMPLATE_MARKUP_INVALID") showProblems("html", (answer.data.problems as Problem[]) ?? []);
			return;
		}
		const shown = answer.data as {
			html: string;
			stylesheet: { css: string };
			checks: { check: string; at: string; detail?: string }[];
		};
		qualityChecks = shown.checks;
		showChecks();
		showProblems("html", []);
		swapPage(shown.html);
		applyStylesheet(shown.stylesheet.css);
	}

	async function saveHtml(version: string | null | undefined): Promise<void> {
		const current = opened;
		if (!current?.source.editable) return;
		if (busy.has(htmlSave)) return;
		busy.add(htmlSave);
		setStatusText(word("saving"));
		if (panelsAdapter) {
			const saved = await panelsAdapter.save();
			busy.delete(htmlSave);
			if (saved) {
				setDirty("html");
				showProblems("html", []);
				savedNote = word("savedName", { name: currentName() });
				setStatusText(savedNote);
				announce(savedNote);
			} else await preview();
			return;
		}
		const markup = html.get();
		const answer = await call("code/save", {
			path,
			ref: current.ref,
			markup,
			version: version === undefined || version === null ? current.version : version,
		});
		busy.delete(htmlSave);
		if (answer.ok) {
			const saved = answer.data as { markup: string; version: string };
			current.version = saved.version;
			savedMarkup = saved.markup;
			if (html.get() === markup) html.set(saved.markup, true);
			setDirty("html");
			showProblems("html", []);
			savedNote = word("savedName", { name: currentName() });
			setStatusText(savedNote);
			announce(savedNote);
			return;
		}
		if (answer.code === "TEMPLATE_MARKUP_INVALID") showProblems("html", (answer.data.problems as Problem[]) ?? []);
		if (answer.code === "CHANGED_MEANWHILE") {
			const choice = await conflict();
			if (choice === "overwrite") await saveHtml((answer.data.version as string | null) ?? null);
			else if (choice === "reload") await open(selectedRef ?? current.ref);
			return;
		}
		const reason = errorText(answer.code);
		setStatusText(word("notSaved", { reason }));
		announce(word("notSaved", { reason }));
	}

	/** Puts each block element of the HTML panel on its own line, changing nothing else (see `formatMarkup`). */
	function format(): void {
		if (!opened?.source.editable) return;
		const text = html.get();
		const formatted = formatMarkup(text);
		if (formatted !== text) html.insert(formatted, 0, text.length);
		html.area.focus();
	}

	/**
	 * Template markup with line breaks and indentation between tags where whitespace never shows on
	 * the page: next to a block boundary (the start or end of a block container, before or after a
	 * block element), where CSS drops spaces at the start and end of lines. Only between two tags
	 * (elements or Components), never next to text, values or commands (so an element showing one
	 * value alone stays editable in place), and never inside `<pre>`. Nothing else changes, so the
	 * markup saves to the same elements and reads back exactly as formatted.
	 */
	function formatMarkup(text: string): string {
		const tag =
			/<!--[\s\S]*?-->|\\\{\{|\{\{[\s\S]*?\}\}|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
		type Token = { kind: "start" | "end" | "component" | "other"; name: string };
		const stack: string[] = [];
		let out = "";
		let last = 0;
		let previous: Token | null = null;
		for (const match of text.matchAll(tag)) {
			const at = match.index ?? 0;
			const between = text.slice(last, at);
			const current: Token = match[1]
				? { kind: "end", name: match[1].toLowerCase() }
				: match[2]
					? /^[A-Z]/.test(match[2])
						? { kind: "component", name: match[2] }
						: { kind: "start", name: match[2].toLowerCase() }
					: { kind: "other", name: "" };
			const tags = previous !== null && previous.kind !== "other" && current.kind !== "other";
			const blockBefore =
				previous !== null &&
				((previous.kind === "end" && BLOCK.has(previous.name)) ||
					(previous.kind === "start" && CONTAINERS.has(previous.name)));
			const blockAfter =
				(current.kind === "start" && BLOCK.has(current.name)) ||
				(current.kind === "end" && CONTAINERS.has(current.name));
			const preformatted = stack.some((name) => name === "pre" || name === "textarea");
			if (tags && (blockBefore || blockAfter) && !preformatted && /^\s*$/.test(between)) {
				const depth = current.kind === "end" ? stack.length - 1 : stack.length;
				out += `\n${"  ".repeat(Math.max(0, depth))}`;
			} else out += between;
			out += match[0];
			if (current.kind === "start" && match[3] !== "/" && !VOID.has(current.name)) stack.push(current.name);
			if (current.kind === "end") {
				const open = stack.lastIndexOf(current.name);
				if (open >= 0) stack.length = open;
			}
			previous = current;
			last = at + match[0].length;
		}
		return out + text.slice(last);
	}

	function conflict(): Promise<string> {
		return ask(word("conflictTitle"), word("conflictText", { name: currentName() }), [
			["cancel", word("cancel"), "secondary"],
			["reload", word("reload"), "secondary"],
			["overwrite", word("overwrite"), "danger"],
		]);
	}

	function showProblems(panel: "html", problems: readonly Problem[]): void {
		const list = htmlProblems;
		list.replaceChildren(
			...problems.map((problem) => {
				const item = el(
					"li",
					{},
					button(
						{ class: "problem-link" },
						word("problemAt", { line: problem.line, column: problem.column, message: problem.message }),
					),
				);
				item.querySelector("button")?.addEventListener("click", () => {
					const offset = offsetOf(html.get(), problem.line, problem.column);
					html.area.focus();
					html.area.setSelectionRange(offset, offset);
					html.reveal(offset);
				});
				const unknown = /There is no Class named ([^\s]+) on this Site/.exec(problem.message)?.[1];
				if (unknown) {
					const make = button({ class: "small secondary" }, word("createClass", { name: unknown }));
					make.addEventListener("click", () => void createClass(unknown));
					item.append(make);
				}
				return item;
			}),
		);
		list.hidden = problems.length === 0;
		html.problems(problems.map((problem) => problem.line));
		status[panel] =
			problems.length === 0
				? ""
				: problems.length === 1
					? word("problemsOne", { panel: word("html") })
					: word("problemsOther", { panel: word("html"), count: problems.length });
		setStatus();
	}

	function setDirty(_panel: Panel): void {
		setStatus();
	}

	function setStatus(): void {
		const parts = [status.html || word("valid", { panel: word("html") })];
		if (savedNote) parts.push(savedNote);
		statusLine.textContent = parts.join(" · ");
	}

	function setStatusText(text: string): void {
		savedNote = text;
		setStatus();
	}

	async function createClass(name: string): Promise<void> {
		const answer = await call("code/createClass", { name });
		if (!answer.ok) {
			setStatusText(errorText(answer.code));
			return;
		}
		opened?.suggestions.classes.push({ name, utility: false });
		announce(word("classCreated", { name }));
		setStatusText(word("classCreated", { name }));
		schedulePreview();
	}

	// ---------------------------------------------------------------------------------------------
	// The JS panel

	async function loadScripts(): Promise<void> {
		const answer = await call("code/scripts", { path, ref: requestRef(selectedRef) });
		if (!answer.ok) return;
		scripts = answer.data as Scripts;
		if (!scripts.page && jsKind === "page") jsKind = "site";
		if (!scripts.component && jsKind === "component") jsKind = scripts.page ? "page" : "site";
		showScript();
	}

	/**
	 * The selection changed: the Component tab follows the Placement it is (or is inside), unless the
	 * tab holds changes not saved yet.
	 */
	async function loadComponentScript(ref: string | null): Promise<void> {
		if (!scripts || (jsKind === "component" && jsDirty())) return;
		const run = ++componentScriptLoadRun;
		const answer = await call("code/scripts", { path, ref: requestRef(ref) });
		if (run !== componentScriptLoadRun || !answer.ok || !scripts) return;
		const component = (answer.data as Scripts).component ?? null;
		// Typed meanwhile in the Component tab: it keeps what is being written.
		if (jsKind === "component" && jsDirty()) return;
		scripts.component = component;
		// Another tab is shown: only the Component tab's button follows, so nothing typed there is lost.
		if (jsKind !== "component") {
			jsComponentTab.hidden = !component;
			return;
		}
		if (!component) jsKind = scripts.page ? "page" : "site";
		showScript();
	}

	function switchScript(kind: ScriptKind): void {
		if (kind === "page" && !scripts?.page) return;
		if (kind === "component" && !scripts?.component) return;
		jsKind = kind;
		showScript();
	}

	function currentScript(): Script | null {
		if (!scripts) return null;
		if (jsKind === "component") return scripts.component ?? null;
		return jsKind === "site" ? scripts.site : scripts.page;
	}

	/** The Component tab's settings as the panel shows them now. */
	function componentSettings(): { consentCategory: string; libraryIds: string[] } {
		return scriptSettings.get();
	}

	function jsDirty(): boolean {
		if (!jsEditor) return false;
		if (jsEditor.get() !== jsSaved) return true;
		return jsKind === "component" && encode(componentSettings()) !== jsSettingsSaved;
	}

	function showScript(): void {
		const script = currentScript();
		const component = scripts?.component ?? null;
		jsPageTab.setAttribute("aria-pressed", String(jsKind === "page"));
		jsSiteTab.setAttribute("aria-pressed", String(jsKind === "site"));
		jsComponentTab.setAttribute("aria-pressed", String(jsKind === "component"));
		jsPageTab.disabled = !scripts?.page;
		jsComponentTab.hidden = !component;
		const onComponent = jsKind === "component" && component !== null;
		jsTitle.textContent = onComponent
			? word("componentScript", { name: component.name })
			: jsKind === "site"
				? word("siteScript")
				: word("pageScript");
		const note = onComponent
			? component.editable
				? ""
				: word("componentFromModule", { name: component.name })
			: scripts?.page
				? ""
				: word("noPageScript");
		jsNote.textContent = note;
		jsNote.hidden = !note;
		jsUsage.hidden = !onComponent;
		if (onComponent) {
			const name = component.name;
			const count = component.pages;
			jsUsage.replaceChildren(
				icon("warning"),
				count === 0
					? word("usedOnNone", { name })
					: count === 1
						? word("usedOnOne", { name })
						: word("usedOnOther", { name, count }),
			);
		} else jsUsage.replaceChildren();
		jsSettings.hidden = !onComponent || !component.editable;
		if (onComponent) showComponentSettings(component);
		jsSaved = script?.code ?? "";
		jsEditor.set(jsSaved);
		const editable = !onComponent || component.editable;
		jsEditor.readOnly(!editable);
		jsSave.disabled = !editable;
		jsEditor.area.setAttribute(
			"placeholder",
			word(onComponent ? "componentPlaceholder" : jsKind === "site" ? "sitePlaceholder" : "pagePlaceholder"),
		);
		jsEditor.area.setAttribute("aria-label", word("jsOf", { name: jsTitle.textContent }));
	}

	function showComponentSettings(component: ComponentScript): void {
		scriptSettings.set(component);
		jsSettingsSaved = encode(componentSettings());
	}

	async function saveScript(version: string | null | undefined): Promise<boolean> {
		const script = currentScript();
		if (!script) return false;
		if (busy.has(jsSave)) return false;
		const component = jsKind === "component" ? (scripts?.component ?? null) : null;
		if (component && !component.editable) return false;
		busy.add(jsSave);
		const code = jsEditor.get();
		const settingsAtSave = componentSettings();
		const kindAtSave = jsKind;
		const answer = await call("code/saveScript", {
			path,
			kind: jsKind,
			code,
			...(component ? { componentId: component.componentId, ...settingsAtSave } : {}),
			version: version === undefined || version === null ? script.version : version,
		});
		busy.delete(jsSave);
		if (answer.ok) {
			const saved = answer.data as Script;
			Object.assign(script, saved);
			jsSaved = saved.code;
			if (component) jsSettingsSaved = encode(settingsAtSave);
			savedNote = word("savedName", { name: jsTitle.textContent ?? "" });
			setStatusText(savedNote);
			announce(savedNote);
			return (
				jsKind === kindAtSave &&
				jsEditor.get() === code &&
				(!component || encode(componentSettings()) === encode(settingsAtSave))
			);
		}
		if (answer.code === "CHANGED_MEANWHILE") {
			const choice = await ask(word("conflictTitle"), word("conflictText", { name: jsTitle.textContent ?? "" }), [
				["cancel", word("cancel"), "secondary"],
				["reload", word("reload"), "secondary"],
				["overwrite", word("overwrite"), "danger"],
			]);
			if (choice === "overwrite") return saveScript((answer.data.version as string | null) ?? null);
			if (choice === "reload") await loadScripts();
			return false;
		}
		setStatusText(word("notSaved", { reason: errorText(answer.code) }));
		return false;
	}

	/**
	 * Runs the page's scripts again on a freshly rendered page: the Site script, then the Component
	 * script of the Component tab (WebCraft's runtime calls it for each of its Placements; the other
	 * Component scripts already on the page run again on the fresh Placements by themselves), then the
	 * page's. Inserted in order, they run in that order.
	 */
	async function run(): Promise<void> {
		if (busy.has(jsRun)) return;
		busy.add(jsRun);
		jsRun.replaceChildren(icon("play"), word("running"));
		const saved = !jsDirty() || (await saveScript(null));
		if (saved) {
			// New code of the Component tab's script runs on the fresh page, not the code loaded before it.
			const fresh = scripts?.component?.src && !loadedComponentScripts().has(scripts.component.src);
			if (fresh && scripts?.component) {
				(
					win as { webcraft?: { componentScript?: { forget?: (id: string) => void } } }
				).webcraft?.componentScript?.forget?.(scripts.component.componentId);
			}
			await preview();
			// Modules stay: the browser runs each once, and the list above reads what was loaded.
			for (const old of doc.querySelectorAll("script[data-wc-run]:not([type=module])")) old.remove();
			const component = scripts?.component ?? null;
			const tags: HTMLScriptElement[] = [];
			const add = (src: string, module = false) => {
				const tag = doc.createElement("script");
				if (module) tag.type = "module";
				tag.async = false;
				tag.src = src;
				tag.dataset.wcRun = "";
				tags.push(tag);
				return tag;
			};
			if (scripts?.site.src) add(scripts.site.src);
			if (component?.src && !loadedComponentScripts().has(component.src)) {
				if (!doc.querySelector(`script[src="${component.runtime}"]`)) add(component.runtime).dataset.wcWatch = "";
				add(component.src, true).dataset.wcComponentScript = component.componentId;
			}
			if (scripts?.page?.src) add(scripts.page.src);
			doc.head.append(...tags);
			announce(word("ran"));
		}
		busy.delete(jsRun);
		jsRun.replaceChildren(icon("play"), word("run"));
	}

	/**
	 * The Component scripts' loaders this page has loaded: a module runs once per page, so one loaded
	 * already isn't loaded again (WebCraft's runtime calls it for fresh Placements by itself).
	 */
	function loadedComponentScripts(): Set<string> {
		return new Set(
			[...doc.querySelectorAll<HTMLScriptElement>("script[type=module][data-wc-component-script]")].map(
				(tag) => tag.getAttribute("src") ?? "",
			),
		);
	}

	// ---------------------------------------------------------------------------------------------
	// The console: what the page's scripts report

	function captureConsole(): void {
		// A Component script's call that failed on one Placement (WebCraft's runtime reports it there):
		// shown against that Placement, which a button selects; the runtime then logs nothing more.
		doc.addEventListener("webcraft:component-error", (event) => {
			const detail = (event as CustomEvent<{ name?: string; message?: string }>).detail ?? {};
			event.preventDefault();
			const root = event.target instanceof Element ? event.target : null;
			const ref = root?.getAttribute("data-wc-code") ?? null;
			logLine("error", word("componentError", { name: detail.name || "?", message: detail.message ?? "" }), ref);
		});
		win.addEventListener("error", (event) => {
			const file = event.filename ? new URL(event.filename, win.location.href).pathname : "";
			const line = word("scriptError", { message: event.message, file: file || "?", line: event.lineno || 0 });
			logLine("error", line);
		});
		win.addEventListener("unhandledrejection", (event) => {
			const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
			logLine("error", reason);
		});
		for (const level of ["log", "info", "warn", "error"] as const) {
			const original = nativeConsole[level];
			console[level] = (...values: unknown[]) => {
				original.apply(console, values);
				logLine(level, values.map((value) => (typeof value === "string" ? value : safeText(value))).join(" "));
			};
		}
	}

	function safeText(value: unknown): string {
		try {
			return value instanceof Error ? value.message : (encode(value) ?? String(value));
		} catch {
			return String(value);
		}
	}

	function logLine(level: "log" | "info" | "warn" | "error", text: string, ref: string | null = null): void {
		if (!consoleList) {
			if (level === "error" && pending.length < 50) pending.push(text);
			return;
		}
		const line = el("li", { class: `console-line ${level}` }, text);
		if (ref) {
			const show = button({ class: "link-button" }, word("showPlacement"));
			show.addEventListener("click", () => void select(ref));
			line.append(" ", show);
		}
		consoleList.append(line);
		while (consoleList.childElementCount > 200) consoleList.firstElementChild?.remove();
		const log = consoleList.parentElement;
		if (log) log.scrollTop = log.scrollHeight;
	}

	// ---------------------------------------------------------------------------------------------
	// Asking: the unsaved-changes and conflict prompts

	let answerDialog: ((choice: string) => void) | null = null;
	let dialogReturn: HTMLElement | null = null;

	function ask(title: string, text: string, actions: [id: string, label: string, kind: string][]): Promise<string> {
		closeDialog();
		dialogReturn = (root.activeElement as HTMLElement | null) ?? null;
		const titleId = newId("dialog");
		const textId = newId("dialog-text");
		const buttons = actions.map(([id, label, kind]) => {
			const choice = button({ class: `small ${kind}` }, label);
			choice.addEventListener("click", () => closeDialog(id));
			return choice;
		});
		const panel = el(
			"div",
			{
				class: "dialog",
				role: "alertdialog",
				"aria-modal": "true",
				"aria-labelledby": titleId,
				"aria-describedby": textId,
			},
			el("h2", { id: titleId }, title),
			el("p", { id: textId }, text),
			el("div", { class: "dialog-actions" }, ...buttons),
		);
		panel.addEventListener("keydown", (event) => {
			if (event.key !== "Tab") return;
			// Focus stays in the prompt while it is open.
			const first = buttons[0];
			const last = buttons.at(-1);
			if (event.shiftKey && root.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && root.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		});
		dialog.replaceChildren(panel);
		dialog.hidden = false;
		buttons[0]?.focus();
		return new Promise((resolve) => {
			answerDialog = resolve;
		});
	}

	function closeDialog(choice = "cancel"): void {
		if (dialog.hidden) return;
		dialog.hidden = true;
		dialog.replaceChildren();
		const resolve = answerDialog;
		answerDialog = null;
		dialogReturn?.focus();
		dialogReturn = null;
		resolve?.(choice);
	}

	// ---------------------------------------------------------------------------------------------
	// Suggestions: what `{{`, `{{@`, `class="`, `<` and CSS offer

	function markupSuggestions(text: string, caret: number, asked: boolean): Context | null {
		const current = opened;
		if (!current) return null;
		const before = text.slice(Math.max(0, caret - 400), caret);
		const offset = caret - before.length;
		const open = before.lastIndexOf("{{");
		if (open >= 0 && !before.slice(open).includes("}}") && before[open - 1] !== "\\") {
			const inside = before.slice(open + 2);
			const from = offset + open;
			const to = text.startsWith("}}", caret) ? caret + 2 : text.startsWith(" }}", caret) ? caret + 3 : caret;
			if (inside.startsWith("@")) {
				const query = inside.slice(1).trimStart().toLowerCase();
				const items: Suggestion[] = [
					...current.suggestions.commands
						.filter((command) => command.name.toLowerCase().startsWith(query))
						.map((command) => ({
							group: word("groups.commands"),
							label: `{{@${command.name}}}`,
							detail:
								word(`commands.${command.name}`) === `commands.${command.name}`
									? undefined
									: word(`commands.${command.name}`),
							insert: command.snippet,
						})),
					...current.suggestions.presets
						.filter((preset) => !query || preset.snippet.slice(3).toLowerCase().startsWith(query))
						.map((preset) => ({
							group: word("groups.presets"),
							label: word(`presets.${preset.id}`),
							detail: preset.snippet.split("\n")[0],
							insert: preset.snippet,
						})),
				];
				return { from, to, items };
			}
			const query = inside.trimStart().toLowerCase();
			const groups: Record<string, string> = {
				entry: word("groups.entry"),
				globals: word("groups.globals"),
				props: word("groups.props"),
			};
			const items: Suggestion[] = current.suggestions.values
				.filter((value) => value.path.toLowerCase().includes(query))
				.map((value) => ({
					group: groups[value.group] ?? value.group,
					label: `{{ ${value.path} }}`,
					detail: value.sample ?? value.label ?? word(`builtIns.${value.path}`),
					insert: `{{ ${value.path} }}`,
				}));
			items.push(
				...current.suggestions.loops.map((loop) => ({
					group: word("groups.loops"),
					label: loop.name,
					insert: `{{@loop ${loop.name}}}$0{{/loop}}`,
				})),
				...current.suggestions.components
					.filter((each) => each.name.toLowerCase().includes(query))
					.map((each) => componentSuggestion(each)),
			);
			return { from, to, items };
		}
		const tagOpen = before.lastIndexOf("<");
		if (tagOpen >= 0 && !before.slice(tagOpen).includes(">")) {
			const inTag = before.slice(tagOpen);
			const component = /^<([A-Z][A-Za-z0-9]*)$/.exec(inTag);
			if (component) {
				const query = component[1] ?? "";
				return {
					from: offset + tagOpen,
					to: caret,
					items: current.suggestions.components
						.filter((each) => each.name.startsWith(query))
						.map((each) => componentSuggestion(each)),
				};
			}
			const classValue = /\sclass="([^"]*)$/.exec(inTag);
			if (classValue) {
				const written = classValue[1] ?? "";
				const query = written.slice(written.lastIndexOf(" ") + 1);
				const from = caret - query.length;
				const known = current.suggestions.classes;
				const items: Suggestion[] = known
					.filter((each) => each.name.startsWith(query))
					.slice(0, 60)
					.map((each) => ({ group: word("groups.classes"), label: each.name, insert: each.name }));
				if (query && /^[A-Za-z_][\w-]*$/.test(query) && !known.some((each) => each.name === query)) {
					items.unshift({
						group: word("groups.classes"),
						label: word("createClass", { name: query }),
						insert: query,
						run: () => createClass(query),
					});
				}
				return items.length > 0 || asked ? { from, to: caret, items } : null;
			}
		}
		return asked ? markupSuggestions(`${text.slice(0, caret)}{{${text.slice(caret)}`, caret + 2, false) : null;
	}

	/** A Component placed with its required Props, the caret in the first one. */
	function componentSuggestion(component: Opened["suggestions"]["components"][number]): Suggestion {
		const required = component.props.filter((prop) => prop.required);
		const props = required.map((prop, index) => ` ${prop.key}="${index === 0 ? "$0" : ""}"`).join("");
		return {
			group: word("groups.components"),
			label: `<${component.name}>`,
			detail: component.props.map((prop) => prop.key).join(", "),
			insert: `<${component.name}${props}${required.length === 0 ? "$0" : ""} />`,
		};
	}

	function openSuggestions(target: Editor, context: Context): void {
		if (context.items.length === 0) {
			closeSuggestions();
			announce(word("noSuggestions"));
			return;
		}
		suggestion = { editor: target, context, active: 0 };
		renderSuggestions();
		const count = context.items.length;
		announce(count === 1 ? word("suggestionsOne") : word("suggestionsOther", { count }));
	}

	/** How many suggestions show at once: the list moves along with the active one instead of scrolling. */
	const SHOWN_SUGGESTIONS = 9;

	function renderSuggestions(): void {
		const open = suggestion;
		if (!open) return;
		const groups = new Map<string, HTMLElement>();
		listbox.replaceChildren();
		const items = open.context.items;
		const start = Math.max(
			0,
			Math.min(open.active - SHOWN_SUGGESTIONS + 1, items.length - SHOWN_SUGGESTIONS, open.active),
		);
		for (const [index, item] of items.entries()) {
			if (index < start || index >= start + SHOWN_SUGGESTIONS) continue;
			let group = groups.get(item.group);
			if (!group) {
				const headingId = newId("group");
				group = el(
					"div",
					{ role: "group", "aria-labelledby": headingId },
					el("div", { class: "suggest-group", id: headingId, role: "presentation" }, item.group),
				);
				groups.set(item.group, group);
				listbox.append(group);
			}
			const option = el(
				"div",
				{
					role: "option",
					id: `${listbox.id}-${index}`,
					class: "suggest-option",
					"aria-selected": String(index === open.active),
				},
				...(item.swatch ? [swatch(item.swatch)] : []),
				el("span", { class: "suggest-label" }, item.label),
				...(item.detail ? [el("span", { class: "suggest-detail" }, item.detail)] : []),
			);
			option.addEventListener("click", () => void accept(index));
			group.append(option);
		}
		listbox.hidden = false;
		open.editor.area.setAttribute("aria-controls", listbox.id);
		open.editor.area.setAttribute("aria-activedescendant", `${listbox.id}-${open.active}`);
		placeSuggestions(open.editor);
	}

	function swatch(value: string): HTMLElement {
		const chip = el("span", { class: "swatch", "aria-hidden": "true" });
		chip.style.background = value;
		return chip;
	}

	function placeSuggestions(target: Editor): void {
		const area = target.area;
		const caret = area.selectionStart;
		const text = area.value;
		const line = lineOf(text, caret) - 1;
		const column = caret - (text.lastIndexOf("\n", caret - 1) + 1);
		const style = win.getComputedStyle(area);
		const lineHeight = Number.parseFloat(style.lineHeight) || 20;
		const charWidth = measureChar(style.font);
		const rect = area.getBoundingClientRect();
		const top = rect.top + Number.parseFloat(style.paddingTop) + (line + 1) * lineHeight - area.scrollTop + 4;
		const left = rect.left + Number.parseFloat(style.paddingLeft) + column * charWidth - area.scrollLeft;
		const height = listbox.offsetHeight;
		const below = top + height < win.innerHeight - 8;
		listbox.style.top = `${Math.round(below ? top : Math.max(8, top - height - lineHeight - 8))}px`;
		listbox.style.left = `${Math.round(Math.max(8, Math.min(left, win.innerWidth - listbox.offsetWidth - 8)))}px`;
	}

	let measured: { font: string; width: number } | null = null;
	function measureChar(font: string): number {
		if (measured?.font === font) return measured.width;
		const canvas = doc.createElement("canvas").getContext("2d");
		let width = 8;
		if (canvas) {
			canvas.font = font;
			width = canvas.measureText("0000000000").width / 10;
		}
		measured = { font, width };
		return width;
	}

	function moveSuggestion(by: number): void {
		const open = suggestion;
		if (!open) return;
		const count = open.context.items.length;
		open.active =
			by === Number.POSITIVE_INFINITY
				? count - 1
				: by === Number.NEGATIVE_INFINITY
					? 0
					: (open.active + by + count) % count;
		renderSuggestions();
	}

	async function accept(index: number): Promise<void> {
		const open = suggestion;
		if (!open) return;
		const item = open.context.items[index];
		closeSuggestions();
		if (!item) return;
		const caretAt = item.insert.indexOf("$0");
		const text = item.insert.replace("$0", "");
		open.editor.insert(text, open.context.from, open.context.to);
		const end = open.context.from + (caretAt >= 0 ? caretAt : text.length);
		open.editor.area.setSelectionRange(end, end);
		open.editor.area.focus();
		if (item.run) await item.run();
	}

	function closeSuggestions(): void {
		const open = suggestion;
		suggestion = null;
		listbox.hidden = true;
		listbox.replaceChildren();
		if (open) {
			open.editor.area.removeAttribute("aria-activedescendant");
			open.editor.area.removeAttribute("aria-controls");
		}
	}

	// ---------------------------------------------------------------------------------------------
	// The code editor: a text area over the highlighted code, with line numbers

	function editor(options: {
		language: Language;
		label: string;
		onInput(): void;
		onCaret(offset: number): void;
		suggest(text: string, caret: number, asked: boolean): Context | null;
		save(): void;
	}): Editor {
		const gutter = el("div", { class: "gutter", "aria-hidden": "true" });
		const code = el("code", {});
		const highlightLayer = el("pre", { class: "highlight", "aria-hidden": "true" }, code);
		const caretLine = el("div", { class: "caret-line", "aria-hidden": "true" });
		const area = el("textarea", {
			class: "source",
			spellcheck: "false",
			autocapitalize: "off",
			autocomplete: "off",
			wrap: "off",
			"aria-label": options.label,
			"aria-autocomplete": "list",
			"data-gramm": "false",
		});
		if (options.language === "markup") {
			area.addEventListener("mousemove", (event) => {
				const rect = area.getBoundingClientRect();
				const style = win.getComputedStyle(area);
				const line = Math.max(
					0,
					Math.floor(
						(event.clientY - rect.top + area.scrollTop - Number.parseFloat(style.paddingTop)) /
							(Number.parseFloat(style.lineHeight) || 20),
					),
				);
				const column = Math.max(
					0,
					Math.floor(
						(event.clientX - rect.left + area.scrollLeft - Number.parseFloat(style.paddingLeft)) /
							measureChar(style.font),
					),
				);
				const lines = area.value.split("\n");
				const offset =
					lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) +
					Math.min(column, lines[line]?.length ?? 0);
				setHover(refAt(offset));
			});
			area.addEventListener("mouseleave", () => setHover(null));
		}
		const surface = el("div", { class: "surface" }, highlightLayer, caretLine, area);
		const rootElement = el("div", { class: `editor language-${options.language}` }, gutter, surface);
		let problemLines = new Set<number>();
		let marked: number | null = null;
		let markedThrough = 0;

		const paint = () => {
			const text = area.value;
			const lines = highlight(options.language, text);
			const hoverAt = options.language === "markup" ? (locationOf(hoveredRef)?.start ?? -1) : -1;
			const hoverLine = hoverAt < 0 ? null : lineOf(text, hoverAt);
			code.innerHTML = lines
				.map((line, index) => {
					const number = index + 1;
					const classes = [
						"line",
						problemLines.has(number) ? "has-problem" : "",
						marked !== null && number >= marked && number <= markedThrough ? "marked" : "",
						hoverLine === number ? "hovered" : "",
					];
					return `<span class="${classes.join(" ").trim()}">${line || " "}</span>`;
				})
				.join("");
			gutter.replaceChildren(
				...lines.map((_, index) => {
					const number = index + 1;
					return el(
						"span",
						{
							class: problemLines.has(number)
								? "has-problem"
								: marked !== null && number >= marked && number <= markedThrough
									? "marked"
									: "",
						},
						String(number),
					);
				}),
			);
			sync();
			if (options.language === "markup") showInsertion?.();
		};
		const sync = () => {
			highlightLayer.scrollTop = area.scrollTop;
			highlightLayer.scrollLeft = area.scrollLeft;
			gutter.scrollTop = area.scrollTop;
			const style = win.getComputedStyle(area);
			const lineHeight = Number.parseFloat(style.lineHeight) || 20;
			const line = lineOf(area.value, area.selectionStart) - 1;
			caretLine.style.top = `${Math.round(Number.parseFloat(style.paddingTop) + line * lineHeight - area.scrollTop)}px`;
			caretLine.style.height = `${Math.round(lineHeight)}px`;
		};
		const caretChanged = () => {
			sync();
			options.onCaret(area.selectionStart);
		};
		area.addEventListener("input", () => {
			paint();
			options.onInput();
			const context = options.suggest(area.value, area.selectionStart, false);
			if (context && (suggestion || shouldOpen(area.value, area.selectionStart, options.language))) {
				openSuggestions(self, context);
			} else if (suggestion?.editor === self && !context) {
				closeSuggestions();
			} else if (suggestion?.editor === self && context) {
				openSuggestions(self, context);
			}
		});
		area.addEventListener("scroll", () => {
			sync();
			if (suggestion?.editor === self) placeSuggestions(self);
		});
		area.addEventListener("keyup", caretChanged);
		area.addEventListener("click", caretChanged);
		area.addEventListener("focus", () => rootElement.classList.add("focused"));
		area.addEventListener("blur", () => {
			rootElement.classList.remove("focused");
			if (suggestion?.editor === self) closeSuggestions();
		});
		area.addEventListener("keydown", (event) => {
			const open = suggestion?.editor === self ? suggestion : null;
			if (open) {
				switch (event.key) {
					case "ArrowDown":
						event.preventDefault();
						moveSuggestion(1);
						return;
					case "ArrowUp":
						event.preventDefault();
						moveSuggestion(-1);
						return;
					case "PageDown":
					case "End":
						event.preventDefault();
						moveSuggestion(Number.POSITIVE_INFINITY);
						return;
					case "PageUp":
					case "Home":
						event.preventDefault();
						moveSuggestion(Number.NEGATIVE_INFINITY);
						return;
					case "Enter":
					case "Tab":
						event.preventDefault();
						void accept(open.active);
						return;
					case "Escape":
						event.preventDefault();
						event.stopPropagation();
						closeSuggestions();
						return;
				}
			}
			if ((event.ctrlKey || event.metaKey) && event.key === " ") {
				event.preventDefault();
				const context = options.suggest(area.value, area.selectionStart, true);
				if (context) openSuggestions(self, context);
				else announce(word("noSuggestions"));
				return;
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				options.save();
				return;
			}
			if (event.key === "Enter" && !event.shiftKey && !event.altKey && !area.readOnly) {
				// A new line keeps the indentation of the one before.
				const start = area.selectionStart;
				const lineStart = area.value.lastIndexOf("\n", start - 1) + 1;
				const indent = /^[ \t]*/.exec(area.value.slice(lineStart, start))?.[0] ?? "";
				event.preventDefault();
				self.insert(`\n${indent}`);
			}
		});

		const self: Editor = {
			root: rootElement,
			area,
			get: () => area.value,
			set(text, keepCaret = false) {
				const caret = area.selectionStart;
				area.value = text;
				if (keepCaret) area.setSelectionRange(Math.min(caret, text.length), Math.min(caret, text.length));
				paint();
			},
			problems(lines) {
				problemLines = new Set(lines);
				paint();
			},
			mark(line, through = line ?? 0) {
				marked = line;
				markedThrough = through;
				paint();
			},
			reveal(offset) {
				const style = win.getComputedStyle(area);
				const lineHeight = Number.parseFloat(style.lineHeight) || 20;
				const line = lineOf(area.value, offset) - 1;
				area.scrollTop = Math.max(0, line * lineHeight - area.clientHeight / 3);
				sync();
			},
			readOnly(on) {
				area.readOnly = on;
				rootElement.classList.toggle("read-only", on);
			},
			insert(text, from, to) {
				const start = from ?? area.selectionStart;
				const end = to ?? area.selectionEnd;
				area.focus();
				area.setSelectionRange(start, end);
				// As typing does, so the browser's undo can take it back.
				if (!doc.execCommand("insertText", false, text)) {
					area.setRangeText(text, start, end, "end");
					area.dispatchEvent(new Event("input"));
				}
			},
		};
		paint();
		return self;
	}

	/** Whether typing just made a place where suggestions open by themselves. */
	function shouldOpen(text: string, caret: number, language: Language): boolean {
		const before = text.slice(Math.max(0, caret - 3), caret);
		if (language === "markup")
			return (
				before.endsWith("{{") ||
				before.endsWith("{{@") ||
				/<[A-Z]$/.test(before) ||
				/class="$/.test(text.slice(Math.max(0, caret - 7), caret))
			);
		return false;
	}

	// ---------------------------------------------------------------------------------------------
	// Highlighting: Template markup and JavaScript, as escaped HTML, one string per line

	function escapeHtml(text: string): string {
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	function highlight(language: Language, text: string): string[] {
		const tokens = language === "markup" ? markupTokens(text) : jsTokens(text);
		const lines: string[] = [""];
		for (const [kind, part] of tokens) {
			const pieces = part.split("\n");
			for (const [index, piece] of pieces.entries()) {
				if (index > 0) lines.push("");
				if (!piece) continue;
				lines[lines.length - 1] += kind ? `<span class="t-${kind}">${escapeHtml(piece)}</span>` : escapeHtml(piece);
			}
		}
		return lines;
	}

	function markupTokens(text: string): [string, string][] {
		const tokens: [string, string][] = [];
		const pattern = /<!--[\s\S]*?(?:-->|$)|\\\{\{|\{\{[\s\S]*?(?:\}\}|$)|<\/?[A-Za-z][\w-]*|[^<{\\]+|[\s\S]/g;
		let inTag = false;
		for (const match of text.matchAll(pattern)) {
			const part = match[0];
			if (part.startsWith("<!--")) tokens.push(["comment", part]);
			else if (part === "\\{{") tokens.push(["", part]);
			else if (part.startsWith("{{")) tokens.push([/^\{\{[@/]/.test(part) ? "command" : "binding", part]);
			else if (/^<\/?[A-Za-z]/.test(part)) {
				tokens.push([/^<\/?[A-Z]/.test(part) ? "component" : "tag", part]);
				inTag = true;
			} else if (inTag) {
				for (const inner of part.matchAll(/"[^"]*"?|'[^']*'?|\/?>|[\w:.@-]+(?==)|[\s\S]/g)) {
					const piece = inner[0];
					if (piece.endsWith(">") && /^\/?>$/.test(piece)) {
						tokens.push(["tag", piece]);
						inTag = false;
					} else if (piece.startsWith('"') || piece.startsWith("'")) tokens.push(["string", piece]);
					else if (/^[\w:.@-]+$/.test(piece) && piece.length > 1) tokens.push(["attribute", piece]);
					else tokens.push([/^[\w:.@-]$/.test(piece) ? "attribute" : "", piece]);
				}
			} else tokens.push(["", part]);
		}
		return tokens;
	}

	function jsTokens(text: string): [string, string][] {
		const tokens: [string, string][] = [];
		const pattern =
			/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?|\b\d[\d_.]*\b|[A-Za-z_$][\w$]*|\s+|[\s\S]/g;
		let afterDot = false;
		for (const match of text.matchAll(pattern)) {
			const part = match[0];
			if (part.startsWith("//") || part.startsWith("/*")) tokens.push(["comment", part]);
			else if (/^["'`]/.test(part)) tokens.push(["string", part]);
			else if (/^\d/.test(part)) tokens.push(["number", part]);
			else if (/^[A-Za-z_$]/.test(part))
				tokens.push([afterDot ? "property" : JS_KEYWORDS.has(part) ? "keyword" : "", part]);
			else tokens.push(["", part]);
			if (!/^\s+$/.test(part)) afterDot = part === ".";
		}
		return tokens;
	}

	// ---------------------------------------------------------------------------------------------
	// Text positions

	function lineOf(text: string, offset: number): number {
		let line = 1;
		for (let index = 0; index < offset && index < text.length; index++) if (text.charCodeAt(index) === 10) line++;
		return line;
	}

	/** The offset of a 1-based line and column, as the parser reports problems (in UTF-16 units). */
	function offsetOf(text: string, line: number, column: number): number {
		let at = 0;
		for (let current = 1; current < line; current++) {
			const next = text.indexOf("\n", at);
			if (next < 0) return text.length;
			at = next + 1;
		}
		return Math.min(text.length, at + column - 1);
	}
}
