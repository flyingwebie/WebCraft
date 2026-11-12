import type { editorAccessibility } from "../../ui/builder/editor-accessibility.ts";
import type {
	BarKit,
	BodyTools,
	DetailsPanel,
	ImageTools,
	LoopTools,
	PanelHandle,
	PanelOptions,
	PresencePlace,
	PresenceTarget,
	SharedDraft,
} from "./kit.ts";

/**
 * What the editing bar's script is given when it is made: the addresses of its own stylesheet and of
 * the module that opens the page's Drafts live (Co-editing), and the narrowest window Code mode opens
 * in (`EDITOR_WIDTHS.min`, #138).
 */
export type EditingBarConfig = {
	styles: string;
	drafts: string;
	body: string;
	layout: string;
	layoutStyles: string;
	codeMinWidth: number;
};

/**
 * The bar's parts, each one self-contained function served in the same script (`assets.ts`): the
 * image popover, Loop item tools and Page details, made with the bar's kit once it starts.
 */
export type EditingBarParts = {
	accessibility: typeof editorAccessibility;
	images(kit: BarKit): ImageTools;
	loops(kit: BarKit): LoopTools;
	details(kit: BarKit): DetailsPanel;
};

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
 *
 * Because it runs first, it also hears when one of the Site's own scripts (a Library, the Site script
 * or the page's script) throws or doesn't load, and says so, with a way into Safe mode (ADR 0022) and,
 * for Staff, to the script in Code mode. In Safe mode the page runs none of them, and the bar says so.
 */
export function editingBar(config: EditingBarConfig, parts: EditingBarParts): void {
	type Words = { [key: string]: string | Words };
	type Change = {
		item: string;
		key: string;
		label: string | null;
		type: string;
		by: { name: string; you: boolean } | null;
		/** A change to Structure's Draft (a Loop's items): only those who may change Structure publish it. */
		structure?: boolean;
	};
	/** The Review of one of the page's items (GLOSSARY.md › Review): In review, or sent back with a comment. */
	type PageReview = {
		item: string;
		status: "inReview" | "sentBack";
		by: { name: string; you: boolean } | null;
		at: string;
		note: string | null;
		comment: string | null;
		canWithdraw: boolean;
		changedSinceSubmitted: boolean;
	};
	type State = {
		page: { title: string; path: string; item: string | null; layout: boolean };
		canPublish: boolean;
		canCode: boolean;
		changes: Change[];
		reviews: PageReview[];
		publishAll: { url: string; otherDrafts: number };
		pages: { title: string; path: string }[];
		person: { name: string };
		site: { name: string };
		language: { code: string; name: string };
		defaultLanguage: string;
		languages: { code: string; name: string; path: string; current: boolean }[];
		words?: Words;
	};
	type Answer = { ok: true; data: unknown } | { ok: false; code: string; data?: unknown };
	type Problem = { at: string; message: string; rule?: string };
	type Popup = { trigger: HTMLButtonElement; panel: HTMLElement; focus(): void; render?(): void };
	/** One of the Site's own scripts that threw, or didn't load (`line` null). */
	type Failure = {
		kind: "site" | "page" | "library" | "component";
		name: string;
		/** For a Component script, its Component. */
		componentId?: string;
		message: string;
		line: number | null;
	};
	/** Someone else in one of the page's shared Drafts (Co-editing, ADR 0025), as the server says. */
	type Participant = {
		id: string;
		personId: string | null;
		name: string;
		via: string | null;
		translation?: boolean;
		colour: number;
		at: string | null;
		self?: boolean;
	};
	type DraftEnds = { receive(data: string | Uint8Array): void; closed(): void };
	type DraftClient = {
		place(at: string | null): void;
		connect(transport: { send(data: string | Uint8Array): void; close(): void }): DraftEnds;
		draft(): unknown;
		change(next: (current: unknown) => unknown): boolean;
		status(): string;
		flush(): void;
	};
	/** The shared-Draft module (`@webcraft/core/draft-document`), as it hands itself to the bar. */
	type DraftsModule = {
		DRAFTS_PROTOCOL: string;
		EDIT_TOKEN_PROTOCOL_PREFIX: string;
		createDraftClient(options: {
			onChange(draft: unknown, from: "local" | "remote"): void;
			onPresence(participants: Participant[]): void;
			onRefused(refusal: { code: string }): void;
			onPublished(by: { name: string; via: string | null } | null): void;
		}): DraftClient;
	};

	const win = window;
	const doc = document;
	// Kept now, before any Site script runs (this script is the first on the page).
	const send = win.fetch.bind(win);
	const encode = JSON.stringify;
	const later = win.setTimeout.bind(win);
	const cancel = win.clearTimeout.bind(win);
	const every = win.setInterval.bind(win);
	const Socket = win.WebSocket;
	const Parser = win.DOMParser;
	const token = doc.querySelector('meta[name="webcraft-edit-token"]')?.getAttribute("content") ?? "";
	/** The page's path; a never-published page whose slug changes in Page details moves (`kit.moved`). */
	let path = win.location.pathname;
	const SVG = "http://www.w3.org/2000/svg";
	const HINT_KEY = "webcraft-edit-hint";
	const PREVIEW_KEY = "webcraft-edit-preview";
	/** Whether the page was rendered for Code mode (ADR 0016): its own script then runs its panels. */
	const coding = doc.querySelector('meta[name="webcraft-code-mode"]')?.getAttribute("content") === "on";
	/** Whether the page is in Safe mode (ADR 0022): it runs none of the Site's own scripts. */
	const safe = doc.querySelector('meta[name="webcraft-safe-mode"]')?.getAttribute("content") === "on";
	/** Which script Code mode's JS panel opens at after the reload a notice asks for: `site` or `page`. */
	const CODE_SCRIPT_KEY = "webcraft-code-script";
	const ErrorEventType = win.ErrorEvent;
	const ScriptElement = win.HTMLScriptElement;
	/** The Site's own scripts that failed on this page, in the order they did. */
	const failures: Failure[] = [];
	let showFailures: (() => void) | null = null;
	let failuresDismissed = false;
	// Heard from now on, before any of the Site's scripts runs: one that throws or doesn't load.
	win.addEventListener(
		"error",
		(event) => {
			const failure = failureOf(event);
			if (!failure) return;
			failures.push(failure);
			showFailures?.();
		},
		true,
	);
	// A Component script's call that failed on one of its Placements (WebCraft's runtime reports it).
	doc.addEventListener("webcraft:component-error", (event) => {
		const detail = (event as CustomEvent<{ component?: string; name?: string; message?: string }>).detail ?? {};
		failures.push({
			kind: "component",
			name: String(detail.name ?? ""),
			componentId: String(detail.component ?? ""),
			message: String(detail.message ?? "").slice(0, 300),
			line: 0,
		});
		showFailures?.();
	});
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
		review: [
			"M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2",
			"M9 3h6v4H9z",
			"m9 14 2 2 4-4",
		],
		sentBack: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
		alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
		close: ["M18 6 6 18", "m6 6 12 12"],
		shield: [
			"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
		],
		image: [
			"M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
			"M9 7a2 2 0 1 0 0 4 2 2 0 1 0 0-4",
			"m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21",
		],
		library: [
			"M18 22H4a2 2 0 0 1-2-2V6",
			"m22 13-1.3-1.3a2.4 2.4 0 0 0-3.4 0L12 17",
			"M14 7a2 2 0 1 0 0 4 2 2 0 1 0 0-4",
			"M8 2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
		],
		upload: ["M12 3v12", "m17 8-5-5-5 5", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
		sparkles: [
			"M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z",
		],
		focus: ["M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20", "M22 12h-4", "M6 12H2", "M12 6V2", "M12 22v-4"],
		details: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M15 3v18"],
		loop: ["m17 2 4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3"],
		up: ["m5 12 7-7 7 7", "M12 19V5"],
		down: ["M12 5v14", "m19 12-7 7-7-7"],
		duplicate: [
			"M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
			"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
		],
		remove: ["M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"],
		add: ["M5 12h14", "M12 5v14"],
		more: [
			"M12 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2",
			"M19 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2",
			"M5 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2",
		],
		forward: ["m9 18 6-6-6-6"],
		grip: [
			"M9 5a1 1 0 1 0 0 2 1 1 0 1 0 0-2",
			"M9 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2",
			"M9 17a1 1 0 1 0 0 2 1 1 0 1 0 0-2",
			"M15 5a1 1 0 1 0 0 2 1 1 0 1 0 0-2",
			"M15 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2",
			"M15 17a1 1 0 1 0 0 2 1 1 0 1 0 0-2",
		],
		strike: ["M16 4H9a3 3 0 0 0-2.83 4", "M14 12a4 4 0 0 1 0 8H6", "M4 12h16"],
	};

	let state: State | null = null;
	let words: Words = {};
	let editing = true;
	let layoutTools: { finish(): Promise<boolean> } | undefined;
	doc.addEventListener("webcraft:page-layout", (event) => {
		layoutTools = (event as CustomEvent).detail;
	});
	let ended = false;

	let host: HTMLElement;
	let root: ShadowRoot;
	/** The element in the shadow root everything the bar shows goes in. */
	let layer: HTMLElement;
	/** Turns Code mode on, unless the window is too narrow for it (then a notice says so). */
	let startCode: (from: HTMLElement) => void = () => {};
	let bar: HTMLElement;

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
	/** The bar's parts, made once it starts. */
	let kit: BarKit;
	let images: ImageTools | null = null;
	let loops: LoopTools | null = null;
	let details: DetailsPanel | null = null;
	/** The block editor's body part (#79), once its module loaded (pages showing a body). */
	let body: BodyTools | null = null;
	let detailsButton: HTMLButtonElement | null = null;
	/** Phones get a compact bar and bottom sheets instead of popovers and the drawer. */
	const phoneWidth = win.matchMedia("(max-width: 640px)");
	const visual = win.visualViewport;
	const DialogElement = win.HTMLDialogElement;

	/** The regions typed over in place (text and rich text); images and Loop items are the parts'. */
	let regions: HTMLElement[] = [];
	/** The page's shared Drafts, by item (`entry:<id>`, `globals`), who else is in each, and the parts hearing it. */
	const drafts = new Map<
		string,
		{
			client: DraftClient;
			participants: Participant[];
			listeners: Set<(draft: unknown) => void>;
			synced: boolean;
			refusals: number;
		}
	>();
	/** The names shown beside regions (and images, Loop items) someone else is in, by what they mark. */
	const presenceTags = new Map<string, HTMLElement>();
	let othersList: HTMLElement;
	let presenceLayer: HTMLElement;
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
		if (["publish", "review/submit", "undo", "end"].includes(action) && layoutTools && !(await layoutTools.finish()))
			return { ok: false, code: "generic" };
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

	/**
	 * Which of the Site's own scripts an error event is about: a script tagged on the page as the Site
	 * script, the page's script or a Library that threw (an `ErrorEvent` from its file) or didn't load
	 * (an error on its element). Null for anything else, such as errors of WebCraft's own files.
	 */
	function failureOf(event: Event): Failure | null {
		let script: HTMLScriptElement | null = null;
		let message = "";
		let line: number | null = null;
		if (event instanceof ErrorEventType) {
			if (!event.filename) return null;
			for (const candidate of doc.querySelectorAll<HTMLScriptElement>(
				"script[data-wc-script], script[data-wc-library], script[data-wc-component-script]",
			)) {
				if (candidate.src === event.filename) script = candidate;
				// A Component script's loader imports the script's own file, named by the same hash.
				const hash = /\/component\/[^/]+\/([0-9a-f]{16})\.js$/.exec(candidate.src)?.[1];
				if (hash && event.filename.endsWith(`/${hash}.js`)) script = candidate;
			}
			message = String(event.message ?? "").slice(0, 300);
			line = event.lineno || 0;
		} else if (event.target instanceof ScriptElement) {
			script = event.target;
		}
		if (!script) return null;
		const tagged = script.getAttribute("data-wc-script");
		const library = script.getAttribute("data-wc-library");
		const component = script.getAttribute("data-wc-component-script");
		if (component !== null) {
			const name = script.getAttribute("data-wc-component-name") ?? "";
			return { kind: "component", name, componentId: component, message, line };
		}
		if (tagged === "site" || tagged === "page") return { kind: tagged, name: "", message, line };
		if (library !== null) return { kind: "library", name: library, message, line };
		return null;
	}

	async function start(): Promise<void> {
		const answer = await call("state", { path });
		if (!answer.ok) return;
		state = answer.data as State;
		words = state.words ?? {};
		build();
		kit = makeKit();
		images = parts.images(kit);
		loops = parts.loops(kit);
		details = parts.details(kit);
		kit.pickImage = images.pick;
		kit.openImage = images.open;
		setUpRegions();
		loadBody();
		if (!coding && state.page.layout) loadLayout();
		openDrafts();
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

	function announce(text: string, priority: "polite" | "interrupt" | "silent" = "polite"): void {
		parts.accessibility(doc).announce(text, priority);
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
		parts.accessibility(doc);
		chip = el("span", { class: "chip" });
		savedNote = el("span", { class: "saved optional" });
		const name = el("span", { class: "site optional" }, s.site.name);
		const safeChip = safe
			? el("span", { class: "chip safe", title: word("safeModeOn") }, icon("shield"), word("safeModeLabel"))
			: null;

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
		const setMode = async (on: boolean) => {
			if (!on && layoutTools && !(await layoutTools.finish())) return;
			editing = on && !ended && !coding;
			modeEdit.setAttribute("aria-pressed", String(editing));
			modePreview.setAttribute("aria-pressed", String(!editing && !coding));
			applyMode();
		};
		// Code mode (ADR 0016) is Staff's: turning it on or off renders the page again, with the Drafts
		// of the Site's Structure or without them.
		const switchCode = async (on: boolean, preview = false) => {
			if (on && layoutTools && !(await layoutTools.finish())) return;
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
		startCode = (from: HTMLElement) => {
			if (!codeTooNarrow(from)) void switchCode(true);
		};
		if (s.canCode || coding) {
			const modeCode = button({ class: "segment", "aria-pressed": String(coding) }, icon("code"), word("codeButton"));
			modeCode.addEventListener("click", () => {
				if (!coding) startCode(modeCode);
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
		// Code mode's Command menu (#131) asks the bar for what only the bar does: Publish opens its
		// confirmation, never publishes at once.
		doc.addEventListener("webcraft:edit-command", (event) => {
			const action = (event as CustomEvent<{ action?: string }>).detail?.action;
			if (action === "publish" && !publishButton.disabled) openPanel(publishPopup);
			else if (action === "safeMode") void switchSafe(!safe);
			else if (action === "preview") void switchCode(false, true);
			else if (action === "leave")
				void call("end", {}).then(() => {
					win.location.reload();
				});
		});

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
				const safeItem = button(
					{ role: "menuitem", tabindex: "-1", class: "menu-row" },
					icon("shield"),
					word(safe ? "safeModeStop" : "safeModeStart"),
				);
				safeItem.addEventListener("click", () => void switchSafe(!safe));
				accountMenu.replaceChildren(
					el(
						"a",
						{ role: "menuitem", tabindex: "-1", href: state?.publishAll.url ?? "/", class: "menu-row" },
						icon("admin"),
						word("openAdmin"),
					),
					safeItem,
					endItem,
				);
			},
		};
		popupTrigger(accountPopup);
		accountMenu.addEventListener("keydown", (event) => menuKeys(event, accountMenu));

		// Page details: the page's Entry's values that don't show on it (the drawer; a bottom sheet on a phone).
		if (s.page.item) {
			detailsButton = button(
				{ class: "control details-button", "aria-haspopup": "dialog" },
				icon("details"),
				el("span", { class: "optional" }, word("pageDetails")),
			);
			detailsButton.setAttribute("aria-label", word("pageDetails"));
			const opener = detailsButton;
			opener.addEventListener("click", () => {
				if (details?.isOpen()) details.close(true);
				else details?.open(opener);
			});
		}
		// On a phone: one menu for Preview, the language, Page details and Publish, in a bottom sheet.
		const moreButton = button(
			{ class: "control more", "aria-haspopup": "dialog", "aria-label": word("moreMenu") },
			icon("more"),
		);
		moreButton.addEventListener("click", () => openPhoneMenu(moreButton, setMode));

		othersList = el("ul", { class: "others", "aria-label": word("alsoEditing") });
		presenceLayer = el("div", { class: "presence-layer", "aria-hidden": "true" });
		tag = el("div", { class: "tag", "aria-hidden": "true", hidden: "" });
		problem = el("div", { class: "problem", "aria-hidden": "true", hidden: "" });
		toolbar = buildToolbar();

		bar = el(
			"div",
			{ class: "bar", ...(coding ? { "data-editor-region": "topbar" } : {}) },
			el(
				"div",
				{ class: "start" },
				el("span", { class: "logo", "aria-hidden": "true" }, "W"),
				name,
				el("span", { class: "divider optional", "aria-hidden": "true" }, "/"),
				pageButton,
				pagesMenu,
				chip,
				...(safeChip ? [safeChip] : []),
				savedNote,
			),
			el("div", { class: "middle" }, modes, devices),
			el(
				"div",
				{ class: "end" },
				othersList,
				language,
				languageMenu,
				...(detailsButton ? [detailsButton] : []),
				publishButton,
				publishPanel,
				account,
				accountMenu,
				moreButton,
			),
		);
		// A Site script that failed while the page loaded is shown at once; later ones as they come.
		const notice = el("div", { class: "notice", role: coding ? "region" : "alert", hidden: "" });
		showFailures = () => renderFailures(notice);
		const section = el(
			"section",
			{ class: "edit-mode", "aria-label": word("label") },
			bar,
			notice,
			presenceLayer,
			tag,
			problem,
			toolbar,
		);
		layer = section;
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
		renderFailures(notice);
	}

	/**
	 * The notice under the bar when one of the Site's own scripts failed: which one and its message,
	 * with Safe mode a click away (outside it), and for Staff the script itself in Code mode.
	 */
	function renderFailures(notice: HTMLElement): void {
		const first = failures[0];
		if (!first || failuresDismissed) {
			notice.hidden = true;
			return;
		}
		const what =
			first.kind === "library"
				? word("libraryFailed", { name: first.name })
				: first.kind === "component"
					? word("componentScriptFailed", { name: first.name })
					: word(first.kind === "site" ? "siteScriptFailed" : "pageScriptFailed");
		const detail =
			first.line === null
				? word("scriptNotLoaded")
				: first.line > 0
					? word("scriptErrorAt", { message: first.message, line: first.line })
					: first.message;
		if (coding) {
			const message = `${what} ${detail}`;
			if (notice.getAttribute("aria-label") !== message) announce(message);
			notice.setAttribute("aria-label", message);
		}
		const actions: HTMLElement[] = [];
		if (!safe) {
			const safeButton = button({ class: "primary small" }, icon("shield"), word("openSafeMode"));
			safeButton.addEventListener("click", () => void switchSafe(true));
			actions.push(safeButton);
		}
		if ((state?.canCode || coding) && first.kind !== "library") {
			const codeButton = button({ class: "secondary small" }, icon("code"), word("openScript"));
			const kind = first.kind === "component" ? `component:${first.componentId ?? ""}` : first.kind;
			codeButton.addEventListener("click", () => void openScript(kind, codeButton));
			actions.push(codeButton);
		}
		const dismiss = button({ class: "icon-button", "aria-label": word("dismissNotice") }, icon("close"));
		dismiss.addEventListener("click", () => {
			failuresDismissed = true;
			notice.hidden = true;
			pageButton.focus();
		});
		notice.replaceChildren(
			el(
				"div",
				{ class: "notice-text" },
				icon("alert"),
				el(
					"p",
					{},
					el("strong", {}, what),
					" ",
					detail,
					failures.length > 1 ? ` ${word("moreFailed", { count: failures.length - 1 })}` : "",
				),
			),
			el("div", { class: "notice-actions" }, ...actions, dismiss),
		);
		notice.hidden = false;
	}

	// ---------------------------------------------------------------------------------------------
	// The parts' kit, the page read again, uploads and bottom sheets

	function makeKit(): BarKit {
		const made: BarKit = {
			win,
			doc,
			send,
			later,
			cancel: (timer) => cancel(timer),
			token,
			call,
			upload,
			el,
			button,
			icon,
			word,
			announce,
			errorText,
			richText: cleanHtml,
			problemText,
			state: () => state as State,
			refresh,
			layer,
			root,
			barBottom: () => bar.getBoundingClientRect().bottom,
			editing: () => editing && !ended,
			phone: () => phoneWidth.matches,
			place,
			showTag(target, text) {
				if (!target || !editing || ended) {
					hideTag();
					return;
				}
				tag.textContent = text ?? "";
				tag.hidden = false;
				place(tag, target instanceof HTMLElement ? target.getBoundingClientRect() : target, 2, "above");
			},
			freshPage,
			adopt,
			placeIn: placeAt,
			pageDraft,
			sheet,
			panel,
			moved(next) {
				if (next === path) return;
				path = next;
				win.history.replaceState(win.history.state, "", next);
			},
			pickImage: () => Promise.resolve(null),
			shared: (item) => sharedDraft(item),
		};
		return made;
	}

	/** One of the page's shared Drafts as a part changes it (the body part), once it is open. */
	function sharedDraft(item: string): SharedDraft | null {
		const link = drafts.get(item);
		if (!link) return null;
		const refusals = link.refusals;
		return {
			ready: () => link.synced && link.client.status() !== "readOnly" && link.client.status() !== "ended",
			draft: () => link.client.draft(),
			change: (next) => link.client.change(next),
			listen(listener) {
				link.listeners.add(listener);
				return () => link.listeners.delete(listener);
			},
			saved() {
				link.client.flush();
				const started = Date.now();
				return new Promise((resolve) => {
					const check = () => {
						const status = link.client.status();
						if (link.refusals !== refusals) resolve(false);
						else if (status === "saved") resolve(true);
						else if (status === "readOnly" || status === "ended" || Date.now() - started > 8000) resolve(false);
						else later(check, 100);
					};
					later(check, 50);
				});
			},
		};
	}

	function loadLayout(): void {
		doc.addEventListener(
			"webcraft:layout-tools",
			(event) => {
				const module = (event as CustomEvent<{ mount(kit: BarKit, language: string, styles: string): Promise<void> }>)
					.detail;
				void module.mount(kit, (state as State & { adminLanguage: string }).adminLanguage, config.layoutStyles);
			},
			{ once: true },
		);
		const script = doc.createElement("script");
		script.type = "module";
		script.src = config.layout;
		doc.head.append(script);
	}

	/** Loads the block editor's module on a page showing a body (it hands its part over in an event). */
	function loadBody(): void {
		if (!doc.querySelector('[data-wc-type="body"]')) return;
		doc.addEventListener(
			"webcraft:body",
			(event) => {
				const module = (event as CustomEvent<{ bodyTools(kit: BarKit): BodyTools }>).detail;
				body = module.bodyTools(kit);
				body.setUp(doc);
				body.mode(editing && !ended);
			},
			{ once: true },
		);
		const script = doc.createElement("script");
		script.type = "module";
		script.src = config.body;
		doc.head.append(script);
	}

	/** The page as Edit mode shows it now, read again from the server. */
	async function freshPage(): Promise<Document | null> {
		try {
			const response = await send(win.location.href, {
				credentials: "same-origin",
				cache: "no-store",
				headers: { accept: "text/html" },
			});
			if (!response.ok) return null;
			return new Parser().parseFromString(await response.text(), "text/html");
		} catch {
			return null;
		}
	}

	/** Uploads a file to the Site's Media library, as the image popover does. */
	async function upload(file: File, folderId?: string | null): Promise<Answer> {
		const form = new FormData();
		form.set("file", file);
		if (folderId) form.set("folderId", folderId);
		try {
			const response = await send("/_webcraft/edit/api/media/upload", {
				method: "POST",
				credentials: "same-origin",
				cache: "no-store",
				headers: { "x-webcraft-edit-token": token },
				body: form,
			});
			const data = (await response.json().catch(() => ({}))) as { code?: string };
			if (response.ok) return { ok: true, data };
			if (data.code === "EDIT_MODE_ENDED") end();
			return { ok: false, code: data.code ?? "generic" };
		} catch {
			return { ok: false, code: "generic" };
		}
	}

	let sheets = 0;

	/**
	 * A bottom sheet (on a phone): a modal dialog along the bottom of the screen with a title and a close
	 * button; Escape, the close button or a tap outside it closes it, and focus goes back where it was.
	 */
	function sheet(options: { title: string; from: HTMLElement | null; content: HTMLElement; onClose?(): void }): {
		close(): void;
		dialog: HTMLDialogElement;
	} {
		const id = `wc-sheet-${++sheets}`;
		const dialog = el("dialog", { class: "sheet", "aria-labelledby": id });
		const closeButton = button({ class: "icon-button", "aria-label": word("close") }, icon("close"));
		let closed = false;
		closeButton.addEventListener("click", () => dialog.close());
		// A tap outside the sheet (on its backdrop) closes it; one on the sheet's own padding doesn't.
		dialog.addEventListener("click", (event) => {
			if (event.target !== dialog) return;
			const box = dialog.getBoundingClientRect();
			const inside =
				event.clientX >= box.left &&
				event.clientX <= box.right &&
				event.clientY >= box.top &&
				event.clientY <= box.bottom;
			if (!inside) dialog.close();
		});
		dialog.addEventListener("close", () => {
			if (closed) return;
			closed = true;
			dialog.remove();
			options.onClose?.();
			if (options.from?.isConnected) options.from.focus();
		});
		dialog.append(
			el("div", { class: "sheet-handle", "aria-hidden": "true" }),
			el("div", { class: "panel-head" }, el("h2", { id, class: "panel-title" }, options.title), closeButton),
			options.content,
		);
		layer.append(dialog);
		if (dialog instanceof DialogElement) dialog.showModal();
		return {
			dialog,
			close: () => {
				if (!closed) dialog.close();
			},
		};
	}

	let panels = 0;

	/**
	 * One of the bar's own floating popovers or drawers (the image popover, a Loop item's form, Page
	 * details): the mechanic every one of them shares (`kit.panel`), so only what differs between them
	 * (their classes, their body, their anchor, what else closing does) stays their own. Escape, the
	 * close button and, on a phone, the bottom sheet's own dismissal (backdrop, its close button) all
	 * close it exactly once, however they got there; `returnFocus` then runs the caller's `focusBack`.
	 */
	function panel(options: PanelOptions): PanelHandle {
		const onPhone = phoneWidth.matches;
		const titleId = `wc-panel-${++panels}`;
		const made = el("div", {});
		if (onPhone) made.className = "sheet-body";
		else {
			made.className = options.className;
			made.setAttribute("role", "dialog");
			made.setAttribute("aria-labelledby", titleId);
			made.setAttribute("tabindex", "-1");
		}
		let closed = false;
		let sheetHandle: ReturnType<typeof sheet> | null = null;
		let scrollHandler: (() => void) | null = null;

		const reposition = () => {
			if (!onPhone && options.anchor) place(made, options.anchor(), options.gap ?? 8, options.prefer ?? "below");
		};

		function close(returnFocus: boolean): void {
			if (closed) return;
			closed = true;
			options.onClose?.();
			if (scrollHandler) {
				win.removeEventListener("scroll", scrollHandler, true);
				scrollHandler = null;
			}
			if (options.htmlClass) doc.documentElement.classList.remove(options.htmlClass);
			if (sheetHandle) {
				const was = sheetHandle;
				sheetHandle = null;
				was.close();
			} else {
				made.remove();
			}
			options.afterClose?.();
			if (returnFocus) options.focusBack();
		}

		made.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close(true);
		});

		if (onPhone) {
			made.append(...options.content(true));
			sheetHandle = sheet({ title: options.title, from: null, content: made, onClose: () => close(false) });
		} else {
			const closeButton = button({ class: "icon-button", "aria-label": word("close") }, icon("close"));
			closeButton.addEventListener("click", () => close(true));
			made.append(
				el(
					"div",
					{ class: "panel-head" },
					el("h2", { id: titleId, class: "panel-title" }, icon(options.headIcon), options.title),
					closeButton,
				),
				...options.content(false),
			);
			layer.append(made);
			if (options.htmlClass) doc.documentElement.classList.add(options.htmlClass);
			if (options.anchor) {
				reposition();
				scrollHandler = reposition;
				win.addEventListener("scroll", scrollHandler, { passive: true, capture: true });
			}
		}
		return { panel: made, close, reposition };
	}

	/**
	 * The phone's menu, in a bottom sheet: Preview (or Edit), the language (its own sheet of the page in
	 * each language), Page details, the admin, ending Edit mode, and the page's changes with Publish (or
	 * Submit for review), which opens the Publish menu in a sheet of its own.
	 */
	function openPhoneMenu(from: HTMLElement, setMode: (on: boolean) => void): void {
		const s = state as State;
		const rows = el("ul", { class: "sheet-rows" });
		const row = (iconName: string, text: string, sub: string | null, act: () => void, attributes = {}) => {
			const made = button(
				{ class: "sheet-row", ...attributes },
				icon(iconName),
				el("span", { class: "sheet-row-text" }, text),
				...(sub ? [el("span", { class: "sheet-row-sub" }, sub)] : []),
				icon("forward"),
			);
			made.addEventListener("click", act);
			rows.append(el("li", {}, made));
			return made;
		};
		let menu: ReturnType<typeof sheet> | null = null;
		const then = (work: () => void) => () => {
			menu?.close();
			work();
		};
		if (!coding) {
			row(
				editing ? "preview" : "edit",
				editing ? word("preview") : word("edit"),
				null,
				then(() => setMode(!editing)),
			);
			if (s.canCode)
				row(
					"code",
					word("codeButton"),
					null,
					then(() => startCode(from)),
				);
		}
		if (s.languages.length > 1) {
			row(
				"language",
				word("languageRow"),
				s.language.name,
				then(() => openLanguageSheet(from)),
			);
		}
		if (s.page.item && editing && !ended)
			row(
				"details",
				word("pageDetails"),
				null,
				then(() => details?.open(from)),
			);
		const admin = el(
			"a",
			{ class: "sheet-row", href: s.publishAll.url },
			icon("admin"),
			el("span", { class: "sheet-row-text" }, word("openAdmin")),
			icon("forward"),
		);
		rows.append(el("li", {}, admin));
		row("end", word("end"), null, async () => {
			await call("end", {});
			win.location.reload();
		});
		const count = s.changes.length;
		const labels = s.changes.map((change) => change.label ?? word(`builtIns.${change.key}`)).join(" · ");
		const publish = button(
			{ class: "primary wide" },
			icon(s.canPublish ? "publish" : "review"),
			s.canPublish ? word("publishPage") : word("changes"),
		);
		publish.disabled = ended;
		publish.addEventListener(
			"click",
			then(() => openPublishSheet(from)),
		);
		const content = el(
			"div",
			{ class: "sheet-body" },
			rows,
			el(
				"div",
				{ class: "sheet-changes" },
				el(
					"p",
					{ class: "change-label" },
					count === 0 ? word("nothingToPublish") : count === 1 ? word("changesOne") : word("changesOther", { count }),
				),
				...(labels ? [el("p", { class: "change-sub" }, labels)] : []),
				publish,
			),
		);
		menu = sheet({ title: s.page.title || s.page.path, from, content });
	}

	function openLanguageSheet(from: HTMLElement): void {
		const s = state as State;
		const list = el(
			"ul",
			{ class: "sheet-rows" },
			...s.languages.map((choice) =>
				el(
					"li",
					{},
					el(
						"a",
						{
							class: "sheet-row",
							href: choice.path,
							hreflang: choice.code,
							...(choice.current ? { "aria-current": "page" } : {}),
						},
						el("span", { class: "sheet-row-text", lang: choice.code }, choice.name),
						el("span", { class: "sheet-row-sub" }, choice.code),
					),
				),
			),
		);
		sheet({ title: word("languages"), from, content: el("div", { class: "sheet-body" }, list) });
	}

	function openPublishSheet(from: HTMLElement): void {
		const s = state as State;
		const panel = el("div", { class: "sheet-body publish-sheet", tabindex: "-1" });
		renderPublish(panel);
		// The sheet's own title says what it is; the panel's heading keeps its id for the panel itself.
		panel.querySelector("h2")?.remove();
		sheet({
			title: s.canPublish
				? word("publishTitle", { title: s.page.title })
				: word("changesTitle", { title: s.page.title }),
			from,
			content: panel,
		});
		panel.querySelector<HTMLElement>("button")?.focus();
	}

	/** Turns Safe mode on or off for this browser, then shows the page again. */
	async function switchSafe(on: boolean): Promise<void> {
		const answer = await call(on ? "safe/start" : "safe/stop", {});
		if (answer.ok) win.location.reload();
	}

	/**
	 * Opens the failed script in Code mode's JS panel: Code mode on, the panel told which script
	 * (`site`, `page`, or `component:<id>` for a Component's).
	 */
	async function openScript(kind: string, from: HTMLElement): Promise<void> {
		if (!coding && codeTooNarrow(from)) return;
		if (!coding) {
			const answer = await call("code/start", {});
			if (!answer.ok) return;
		}
		try {
			win.sessionStorage.setItem(CODE_SCRIPT_KEY, kind);
		} catch {
			// Code mode still opens; the JS panel shows the page's script.
		}
		win.location.reload();
	}

	/**
	 * Below the narrowest window Code mode opens in (the window's width only, as it is now), the Code
	 * switch says so in a short notice under the control pressed, and Edit mode stays on.
	 */
	function codeTooNarrow(from: HTMLElement): boolean {
		if (win.matchMedia(`(min-width: ${config.codeMinWidth}px)`).matches) return false;
		const title = el("h2", { id: "wc-code-too-narrow" }, word("codeTooNarrow"));
		const close = button({ class: "secondary small" }, word("close"));
		close.addEventListener("click", () => closePopup(true));
		const panel = el(
			"div",
			{ class: "popup dialog", role: "dialog", "aria-labelledby": title.id, tabindex: "-1" },
			title,
			el("p", { class: "intro" }, word("codeTooNarrowText")),
			el("div", { class: "confirm-actions" }, close),
		);
		layer.append(panel);
		const popup: Popup = { trigger: from as HTMLButtonElement, panel, focus: () => panel.focus() };
		openPanel(popup);
		// Made for this one time: gone once closed, so no second notice stays in the bar.
		const gone = new MutationObserver(() => {
			if (!panel.hidden) return;
			gone.disconnect();
			panel.remove();
			from.removeAttribute("aria-expanded");
		});
		gone.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
		return true;
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
			el("p", { class: "hint-text" }, word(phoneWidth.matches ? "hintTextTouch" : "hintText")),
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
		const inReview = s.reviews.some((review) => review.status === "inReview");
		chip.className = inReview ? "chip review" : count > 0 ? "chip draft" : "chip";
		chip.textContent = ended
			? word("ended")
			: inReview
				? word("inReview")
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
		const error = el("p", { class: "error" });
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
							const undo = button(
								{ class: "link-button", "aria-label": word("revertChange", { label }) },
								word("revert"),
							);
							undo.addEventListener("click", async () => {
								undo.disabled = true;
								const answer = await call("undo", { path, item: change.item, key: change.key });
								if (answer.ok) win.location.reload();
								else {
									undo.disabled = false;
									error.textContent = errorText(answer.code);
									announce(error.textContent, "interrupt");
								}
							});
							return el(
								"li",
								{},
								icon(
									change.type === "text" || change.type === "richText"
										? "text"
										: change.type === "loopItems"
											? "loop"
											: change.type === "media"
												? "image"
												: "page",
								),
								el(
									"span",
									{ class: "change" },
									el("span", { class: "change-label" }, label),
									el(
										"span",
										{ class: "change-sub" },
										change.item === "globals"
											? `${by} · ${word("globals")}`
											: change.structure && !s.canCode
												? `${by} · ${word("staffPublish")}`
												: by,
									),
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
						announce(error.textContent, "interrupt");
					}
				});
			});
			actions.append(discard);
		}
		if (s.canPublish) {
			const publish = button({ class: "primary" }, icon("publish"), word("publishPage"));
			// Only those who may change Structure publish a Loop's items: disabled when every change
			// left is one of those (nothing else here for this person to publish).
			const publishable = s.changes.filter((change) => !change.structure || s.canCode);
			publish.disabled = publishable.length === 0;
			publish.addEventListener("click", async () => {
				publish.disabled = true;
				publish.replaceChildren(word("publishing"));
				const answer = await call("publish", { path });
				if (answer.ok) {
					const next = answer.data as State;
					// Honest about what actually went live: a Loop item change that is still one of the
					// page's changes afterwards waited for Staff, even though publishing was answered 200.
					const stillWaiting = s.changes.some(
						(change) =>
							change.structure &&
							next.changes.some((remaining) => remaining.item === change.item && remaining.key === change.key),
					);
					state = { ...next, words };
					renderStatus();
					renderPublish(panel);
					panel.focus();
					announce(stillWaiting ? word("publishedWaiting") : word("published"));
				} else {
					publish.disabled = false;
					publish.replaceChildren(icon("publish"), word("publishPage"));
					error.textContent = errorText(answer.code);
					announce(error.textContent, "interrupt");
				}
			});
			actions.append(publish);
		} else {
			renderSubmit(panel, actions, error);
		}
		const others = s.publishAll.otherDrafts;
		panel.replaceChildren(
			el(
				"h2",
				{ id: "wc-publish-title" },
				s.canPublish ? word("publishTitle", { title: s.page.title }) : word("changesTitle", { title: s.page.title }),
			),
			el("p", { class: "intro" }, s.canPublish ? word("publishIntro") : word("authorIntro")),
			...reviewBlocks(s),
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

	/** A time as the admin shows it: `2026-03-02 09:00 UTC`. */
	function utcTime(at: string): string {
		return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
	}

	/**
	 * Where the page's Reviews stand (GLOSSARY.md › Review): each item In review (who submitted it,
	 * when, their note) and each sent back, with its comment, until it is submitted again.
	 */
	function reviewBlocks(s: State): HTMLElement[] {
		const itemName = (review: PageReview) => (review.item === "globals" ? word("globals") : s.page.title);
		return s.reviews.map((review) => {
			const who = review.by ? (review.by.you ? word("reviewYou") : review.by.name) : word("someone");
			if (review.status === "sentBack") {
				return el(
					"div",
					{ class: "review sent-back" },
					el(
						"p",
						{ class: "review-head" },
						icon("sentBack"),
						word("sentBackBy", { item: itemName(review), name: who, time: utcTime(review.at) }),
					),
					el("blockquote", {}, review.comment ?? ""),
					el("p", { class: "review-help" }, word("sentBackHelp")),
				);
			}
			return el(
				"div",
				{ class: "review" },
				el(
					"p",
					{ class: "review-head" },
					icon("review"),
					word("inReviewBy", { item: itemName(review), name: who, time: utcTime(review.at) }),
				),
				...(review.note ? [el("blockquote", {}, review.note)] : []),
				...(review.changedSinceSubmitted ? [el("p", { class: "review-help" }, word("changedSinceSubmitted"))] : []),
			);
		});
	}

	/**
	 * What Authors get instead of Publish: "Submit for review" with an optional note for the page's
	 * changes, or, once they wait, "Withdraw from review".
	 */
	function renderSubmit(panel: HTMLElement, actions: HTMLElement, error: HTMLElement): void {
		const s = state as State;
		const waiting = s.reviews.filter((review) => review.status === "inReview");
		const settle = (answer: Answer, done: string) => {
			if (!answer.ok) return false;
			state = { ...(answer.data as State), words };
			renderStatus();
			renderPublish(panel);
			panel.focus();
			announce(done);
			return true;
		};
		const open = s.changes.filter((change) => !waiting.some((review) => review.item === change.item));
		if (open.length > 0) {
			const noteId = "wc-review-note";
			const note = el("textarea", { id: noteId, class: "review-note", rows: "2", maxlength: "2000" });
			const submit = button({ class: "primary" }, icon("review"), word("submitForReview"));
			submit.addEventListener("click", async () => {
				submit.disabled = true;
				submit.replaceChildren(word("submitting"));
				const answer = await call("review/submit", { path, note: note.value });
				if (settle(answer, word("submittedForReview"))) return;
				submit.disabled = false;
				submit.replaceChildren(icon("review"), word("submitForReview"));
				error.textContent = errorText(answer.ok ? "generic" : answer.code);
				announce(error.textContent, "interrupt");
			});
			actions.append(
				el(
					"div",
					{ class: "review-submit" },
					el("label", { for: noteId }, word("reviewNoteLabel")),
					note,
					el("div", { class: "review-actions" }, submit),
				),
			);
			return;
		}
		if (waiting.some((review) => review.canWithdraw)) {
			const withdraw = button({ class: "secondary" }, word("withdrawReview"));
			withdraw.addEventListener("click", async () => {
				withdraw.disabled = true;
				const answer = await call("review/withdraw", { path });
				if (settle(answer, word("withdrawnFromReview"))) return;
				withdraw.disabled = false;
				error.textContent = errorText(answer.ok ? "generic" : answer.code);
				announce(error.textContent, "interrupt");
			});
			actions.append(withdraw);
			return;
		}
		actions.append(el("p", { class: "draft-note" }, icon("saved"), word("savedToDraft")));
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

	/** Text and rich text regions: image regions are the image tools'. */
	const TEXT_REGION = '[data-wc-item][data-wc-field]:not([data-wc-type="media"]):not([data-wc-type="body"])';
	const plainTextOnly = (() => {
		try {
			const probe = doc.createElement("div");
			probe.contentEditable = "plaintext-only";
			return probe.contentEditable === "plaintext-only";
		} catch {
			return false;
		}
	})();

	function setUpRegions(): void {
		adopt([doc.body]);
		doc.addEventListener("selectionchange", () => {
			rememberSelection();
			if (current?.dataset.wcType === "richText") updatePressed();
		});
		const reposition = () => {
			if (current) {
				showTag(current);
				if (!toolbar.hidden) showToolbar(current);
			}
			positionPresence();
			loops?.reposition();
		};
		win.addEventListener("scroll", reposition, { passive: true, capture: true });
		win.addEventListener("resize", reposition, { passive: true });
		// On a phone the text toolbar sits above the on-screen keyboard, which the visual viewport leaves out.
		visual?.addEventListener("resize", reposition);
		visual?.addEventListener("scroll", reposition);
		images?.setUp(doc);
		loops?.scan();
		applyMode();
		// Parts of the page shown again (a Filter's results, a Site script's own) bring regions and Loop
		// marks of their own: they are made editable as they come.
		let rescan = 0;
		new win.MutationObserver((records) => {
			const added = records.flatMap((record) => [...record.addedNodes]).filter((node) => !host.contains(node));
			if (added.length === 0) return;
			adopt(added);
			cancel(rescan);
			rescan = later(() => loops?.scan(), 150);
		}).observe(doc.body, { childList: true, subtree: true });
	}

	/**
	 * Makes the editable regions in nodes new to the page editable (at the start, and when a part shows
	 * a piece of the page again as the server renders it now): text regions here, image regions by the
	 * image tools.
	 */
	function adopt(nodes: readonly Node[]): void {
		regions = regions.filter((region) => region.isConnected);
		for (const node of nodes) {
			if (!(node instanceof Element)) continue;
			const found = [...(node.matches(TEXT_REGION) ? [node] : []), ...node.querySelectorAll(TEXT_REGION)];
			for (const region of found) if (region instanceof HTMLElement) setUpRegion(region);
			images?.setUp(node);
			body?.setUp(node);
		}
		applyMode();
	}

	function setUpRegion(region: HTMLElement): void {
		if (regions.includes(region)) return;
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
		images?.mode(on);
		loops?.mode(on);
		body?.mode(on);
		doc.dispatchEvent(new CustomEvent("webcraft:edit-mode", { detail: { editing: on } }));
		if (!on) {
			hideTag();
			hideToolbar();
			details?.close(false);
		}
		if (detailsButton) detailsButton.disabled = !on;
	}

	function textIn(region: HTMLElement): string {
		if (region.dataset.wcType === "richText") return region.innerHTML;
		return (region.textContent ?? "").replace(/[\r\n]+/g, " ");
	}

	function focusRegion(region: HTMLElement): void {
		if (!editing || ended) return;
		current = region;
		placeIn(region);
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
			placeIn(null);
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
				announce(word("saveFailed", { reason }), "interrupt");
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
			if (found) announce(problemText(found));
			await refresh();
		})();
		saving.set(region, run);
		await run;
	}

	// ---------------------------------------------------------------------------------------------
	// Co-editing (ADR 0025): the page's Drafts are shared with everyone editing them, in the admin or
	// on the Site. Their changes show in the regions as they are saved; who else is here shows in the
	// bar, and the region each is in has an outline in their colour with their name. What is typed here
	// saves through `save`, which goes through the same shared Drafts.

	/** The colours people get (as the admin's), each with white text that reads on it. */
	const PRESENCE_COLOURS = ["#0369a1", "#6d28d9", "#047857", "#b45309", "#be123c", "#0e7490", "#a21caf", "#4d7c0f"];

	/** Loads the shared-Draft module (it hands itself over in an event), then opens each item the page edits. */
	function openDrafts(): void {
		// The page's Entry and the Globals its regions show (a Loop's items aren't opened live): presence on
		// images and Loop items goes through them too.
		const shown = [
			...regions.map((region) => region.dataset.wcItem ?? ""),
			...(images?.targets() ?? []).map((target) => target.item),
			...[...doc.querySelectorAll<HTMLElement>('[data-wc-type="body"]')].map((region) => region.dataset.wcItem ?? ""),
			state?.page.item ?? "",
		];
		const items = [...new Set(shown)].filter((item) => item === "globals" || item.startsWith("entry:"));
		if (items.length === 0) return;
		void import(config.drafts).then((module: DraftsModule) => {
			for (const item of items) openDraft(module, item);
		});
	}

	function openDraft(module: DraftsModule, item: string): void {
		const [kind = "", id = ""] = item.split(":");
		const link = {
			participants: [] as Participant[],
			listeners: new Set<(draft: unknown) => void>(),
			synced: false,
			refusals: 0,
			client: module.createDraftClient({
				onChange: (draft, from) => {
					link.synced = true;
					if (from === "remote") {
						showRemote(item, draft);
						for (const listener of link.listeners) listener(draft);
					}
				},
				onRefused: (refusal) => {
					link.refusals++;
					savedNote.textContent = word("saveFailed", { reason: errorText(refusal.code) });
					announce(savedNote.textContent, "interrupt");
				},
				onPresence: (participants) => {
					link.participants = participants;
					renderPresence();
				},
				onPublished: (by) => {
					if (!by || by.name === state?.person.name) return;
					announce(word("publishedBy", { name: by.via ? word("via", { name: by.name, client: by.via }) : by.name }));
					void refresh();
				},
			}),
		};
		drafts.set(item, link);
		let attempt = 0;
		const connect = () => {
			if (ended) return;
			const scheme = win.location.protocol === "https:" ? "wss:" : "ws:";
			const socket = new Socket(`${scheme}//${win.location.host}/_webcraft/edit/drafts/${kind}${id ? `/${id}` : ""}`, [
				module.DRAFTS_PROTOCOL,
				`${module.EDIT_TOKEN_PROTOCOL_PREFIX}${token}`,
			]);
			socket.binaryType = "arraybuffer";
			let ends: DraftEnds | null = null;
			socket.addEventListener("open", () => {
				attempt = 0;
				ends = link.client.connect({
					send: (data) => socket.send(typeof data === "string" ? data : new Uint8Array(data)),
					close: () => socket.close(),
				});
			});
			socket.addEventListener("message", (event) => {
				ends?.receive(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
			});
			socket.addEventListener("close", (event) => {
				ends?.closed();
				// The session ended or access went: nothing to come back to.
				if (ended || event.code === 4401 || event.code === 4403) return;
				later(connect, [1000, 2000, 4000, 8000, 15_000][Math.min(attempt++, 4)] ?? 15_000);
			});
		};
		connect();
	}

	/** Says which value of its Draft the person is in (a region's key), or nowhere. */
	function placeIn(region: HTMLElement | null): void {
		placeAt(region ? regionPlace(region) : null);
	}

	/**
	 * Where a region is, for presence: its item's Draft and its Field's key. A Loop item's regions are
	 * the Loop item's: presence on it goes through the page's own Draft, naming the item.
	 */
	function regionPlace(region: HTMLElement): PresencePlace | null {
		const item = region.dataset.wcItem ?? "";
		if (item.startsWith("loop:")) {
			const draft = pageDraft();
			return draft ? { item: draft, at: item } : null;
		}
		return { item, at: (region.dataset.wcField ?? "").split(".")[0] ?? "" };
	}

	/** Says where the person is in the page's shared Drafts, or nowhere. */
	function placeAt(place: PresencePlace | null): void {
		for (const [item, link] of drafts) link.client.place(place && place.item === item ? place.at || null : null);
	}

	/** The Draft presence on Loop items goes through: the page's Entry's, else the Globals'. */
	function pageDraft(): string | null {
		if (state?.page.item && drafts.has(state.page.item)) return state.page.item;
		return drafts.has("globals") ? "globals" : null;
	}

	/** Someone else's change: regions nobody is typing in here show the new value. */
	function showRemote(item: string, draft: unknown): void {
		for (const region of regions) {
			if (!region.isConnected || region.dataset.wcItem !== item || region === current || timers.has(region)) continue;
			const value = valueAt(draft, region.dataset.wcField ?? "");
			if (typeof value !== "string" || value === textIn(region)) continue;
			if (region.dataset.wcType === "richText") region.replaceChildren(...cleanHtml(value));
			else region.textContent = value;
			lastSaved.set(region, textIn(region));
		}
	}

	/** A region's value in the page's language (else the Default language's) from a Draft as its document holds it. */
	function valueAt(draft: unknown, field: string): unknown {
		const record = (value: unknown) =>
			value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		let node: unknown = record(draft).values;
		const parts = field.split(".");
		parts.forEach((part, index) => {
			node = record(node)[part];
			if (index < parts.length - 1) node = record(node).values;
		});
		const kept = record(node);
		return kept[state?.language.code ?? ""] ?? kept[state?.defaultLanguage ?? ""];
	}

	/**
	 * Rich text someone else typed, before it shows in the page: only formatting, lists and links to
	 * addresses a page may link to are kept (the server cleans it the same way as it saves it).
	 */
	function cleanHtml(html: string): Node[] {
		const kept = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "S", "CODE", "SUB", "SUP", "A", "UL", "OL", "LI"]);
		const parsed = new Parser().parseFromString(html, "text/html");
		const copy = (node: Node): Node[] => {
			if (node.nodeType === 3) return [doc.createTextNode(node.textContent ?? "")];
			if (node.nodeType !== 1) return [];
			const children = [...node.childNodes].flatMap(copy);
			const element = node as Element;
			if (!kept.has(element.tagName)) return children;
			const made = doc.createElement(element.tagName.toLowerCase());
			const href = element.getAttribute("href");
			if (element.tagName === "A" && href && /^(https?:|mailto:|tel:|\/|#)/i.test(href.trim())) {
				made.setAttribute("href", href.trim());
			}
			made.append(...children);
			return [made];
		};
		return [...parsed.body.childNodes].flatMap(copy);
	}

	/** A participant's name as people read it: the person, and the client they came through. */
	function displayName(participant: Participant): string {
		const name = participant.name || word("someone");
		if (participant.translation) return word("viaTranslation", { name });
		return participant.via ? word("via", { name, client: participant.via }) : name;
	}

	/** The outline boxes drawn around Loop items others are in (they are ranges of nodes, not one element). */
	const presenceBoxes = new Map<string, HTMLElement>();

	/** Who else is in the page's Drafts: avatars in the bar, and an outline and name on each region they are in. */
	function renderPresence(): void {
		const others = new Map<string, Participant & { item: string }>();
		for (const [item, link] of drafts) {
			for (const participant of link.participants) {
				if (!participant.self) others.set(participant.id, { ...participant, item });
			}
		}
		const colourOf = (participant: Participant) =>
			PRESENCE_COLOURS[participant.colour % PRESENCE_COLOURS.length] ?? "#0369a1";
		const seen = new Set<string>();
		othersList.replaceChildren(
			...[...others.values()]
				.filter((participant) => {
					const key = `${participant.personId}:${participant.via ?? ""}:${participant.translation ?? false}`;
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				})
				.map((participant) => {
					const avatar = el(
						"li",
						{ class: "other", title: displayName(participant) },
						el("span", { "aria-hidden": "true" }, initials(participant.name || "?")),
						el("span", { class: "sr-only" }, displayName(participant)),
					);
					avatar.style.background = colourOf(participant);
					return avatar;
				}),
		);
		regions = regions.filter((region) => region.isConnected);
		const targets: PresenceTarget[] = [
			// A Loop item's own regions are outlined with the item (the Loop item tools' targets).
			...regions.flatMap((region) => {
				const place = region.dataset.wcItem?.startsWith("loop:") ? null : regionPlace(region);
				return place ? [{ ...place, rect: () => region.getBoundingClientRect(), outline: region }] : [];
			}),
			...(images?.targets() ?? []),
			...(loops?.targets() ?? []),
			...(body?.targets() ?? []),
		];
		const outlined = new Set<HTMLElement>();
		const tagged = new Set<string>();
		for (const target of targets) {
			const here = [...others.values()].filter(
				(participant) => participant.item === target.item && participant.at === target.at,
			);
			const first = here[0];
			const key = `${target.item}|${target.at}|${target.outline ? regions.indexOf(target.outline) : ""}`;
			if (!first) continue;
			const colour = colourOf(first);
			if (target.outline) {
				target.outline.style.outline = `2px solid ${colour}`;
				target.outline.style.outlineOffset = "3px";
				outlined.add(target.outline);
			} else {
				let box = presenceBoxes.get(key);
				if (!box) {
					box = el("div", { class: "presence-box" });
					presenceLayer.append(box);
					presenceBoxes.set(key, box);
				}
				box.style.borderColor = colour;
				presenceRects.set(box, target.rect);
			}
			let name = presenceTags.get(key);
			if (!name) {
				name = el("div", { class: "presence-tag" });
				presenceLayer.append(name);
				presenceTags.set(key, name);
			}
			// One name for a person however many tabs they have open.
			name.textContent = word("isHere", { name: [...new Set(here.map(displayName))].join(", ") });
			name.style.background = colour;
			presenceRects.set(name, target.rect);
			tagged.add(key);
		}
		// Whatever nobody is in any longer loses its outline and name.
		for (const element of outlinedBefore) {
			if (!outlined.has(element)) {
				element.style.outline = "";
				element.style.outlineOffset = "";
			}
		}
		outlinedBefore = outlined;
		for (const [key, name] of presenceTags) {
			if (tagged.has(key)) continue;
			name.remove();
			presenceTags.delete(key);
			presenceRects.delete(name);
		}
		for (const [key, box] of presenceBoxes) {
			if (tagged.has(key)) continue;
			box.remove();
			presenceBoxes.delete(key);
			presenceRects.delete(box);
		}
		positionPresence();
	}

	/** Where each presence name and box goes, by what it marks. */
	const presenceRects = new Map<HTMLElement, () => DOMRect | null>();
	let outlinedBefore = new Set<HTMLElement>();

	function positionPresence(): void {
		for (const [element, rectOf] of presenceRects) {
			const rect = rectOf();
			if (!rect) continue;
			if (element.classList.contains("presence-box")) {
				element.style.top = `${Math.round(rect.top - 4)}px`;
				element.style.left = `${Math.round(rect.left - 4)}px`;
				element.style.width = `${Math.round(rect.width + 8)}px`;
				element.style.height = `${Math.round(rect.height + 8)}px`;
			} else {
				element.style.top = `${Math.round(rect.bottom + 4)}px`;
				element.style.left = `${Math.round(Math.max(8, rect.left))}px`;
			}
		}
	}

	function problemText(found: Problem): string {
		const text = word(`problems.${found.rule ?? "other"}`);
		return text.startsWith("problems.") ? word("problems.other") : text;
	}

	/** Places a floating element next to `rect`: above it when there is room below the bar, else below. */
	function place(panel: HTMLElement, rect: DOMRect, gap: number, prefer: "above" | "below"): void {
		const barBottom = bar.getBoundingClientRect().bottom;
		const height = panel.offsetHeight;
		const above = rect.top - height - gap;
		const below = rect.bottom + gap;
		const fitsAbove = above >= barBottom + 4;
		const fitsBelow = below + height <= win.innerHeight - 8;
		let top = prefer === "above" ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above;
		// Neither side has room: the panel stays in the window, under the bar.
		if (top < barBottom + 4 || top + height > win.innerHeight - 8) {
			top = Math.max(barBottom + 4, Math.min(top, win.innerHeight - height - 8));
		}
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
		toolbar.classList.toggle("above-keyboard", phoneWidth.matches);
		if (phoneWidth.matches) {
			// On a phone the toolbar sits right above the on-screen keyboard (the visual viewport's bottom).
			const bottom = (visual?.offsetTop ?? 0) + (visual?.height ?? win.innerHeight);
			toolbar.style.top = `${Math.round(bottom - toolbar.offsetHeight - 6)}px`;
			toolbar.style.left = `${Math.round((visual?.offsetLeft ?? 0) + 6)}px`;
			return;
		}
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
