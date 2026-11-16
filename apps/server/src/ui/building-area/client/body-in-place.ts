import type {
	Answer,
	BarKit,
	SharedDraft as BarSharedDraft,
	BarState,
	Words as BarWords,
	BodyChooserLook,
	BodyTools,
	MediaChoice,
} from "../../page-kit.ts";
import { loadBodyEditor } from "../agent/body.ts";
import { BODY_REGION } from "../agent/contract.ts";
import { type EditRequests, fill, type PageState, type Words } from "../api.ts";
import { frameGeometry, nameOf, type Overlay } from "../canvas/overlay.ts";
import type { SavingStatus } from "../canvas/regions.ts";
import { FOCUS_RING } from "../controls.tsx";
import { pickMedia } from "../places/media/pick.ts";
import type { ClientEditing } from "./marks.ts";

/**
 * Writing a post in place (SPEC 13.5, `client-flows/01`, BA-18): an Entry's body is edited as Blocks
 * where it shows, for a Member.
 *
 * The block editor is the editing bar's body part, unchanged in what it does (`body-editor/`): it is
 * loaded into the framed page (`agent/body.ts`), where the caret and the Blocks live, and given a kit
 * of the shell's (`BarKit`). Its toolbar, the `/` menu (the Block list), its forms and its menus are
 * drawn in a layer of the shell's own document over the frame (`BodyInPlace.tsx`), never in the page,
 * so the Site's CSS never reaches them; they are restyled to client editing's look here, by the class
 * names the editor gives them (`CLASSES`), and the Block list draws its choices as tiles with icons
 * (`BarKit.chooser`). The layer sits exactly over the frame's page and has its zoom, so where the
 * editor measures and places things (in the page's coordinates) is where they show.
 *
 * Around client editing's marks (`marks.ts`): a body is one marked area. At rest it is dashed; under
 * the pointer its chip says "Click to edit"; while it is written in, solid with its chip "{label} ·
 * Blocks". Tab reaches it as a whole ("Press Enter to edit"), Enter puts the caret in its first Block,
 * Escape finishes (the tools go, focus stays on the body), then closes the side panel. Inside, the
 * keys are the editor's: Enter starts a Block, `/` on an empty line opens the Block list, Alt+F10
 * reaches the Block's tools, the arrow keys move between Blocks; Tab goes on to the next marked area.
 *
 * Changes go into the page's shared Draft at once (Co-editing), with the Draft's state in the bar.
 * A body's Blocks keep the browser's own Undo, as they did in the editing bar.
 */
export type BodyInPlace = {
	/** Client editing with the page's bodies around it: what happens in a body is handled here first. */
	wrap(editing: ClientEditing): ClientEditing;
	/** The body being written now (focus in one of its Blocks, or in its tools), for its marks. */
	editing(): HTMLElement | null;
	/** The layer the tools are drawn in, and the icons they take (`BodyInPlace.tsx`), or null when gone. */
	mount(parts: { layer: HTMLElement; icons: HTMLElement } | null): void;
	destroy(): void;
};

/** Where a body's tools sit on a phone-wide page (Move up and Move down, sheets from the bottom). */
const PHONE_WIDTH = 640;

/** Room kept between what the editor places and the page's edges, in the page's pixels. */
const EDGE = 4;

/** The shell's own focus ring, on everything the editor draws. */
const RING = FOCUS_RING;

/**
 * The block editor's own class names, drawn in client editing's look (SPEC 13.1: dark, popovers 380
 * wide with radius 14, controls 40 high; the Block list of `client-flows/01`: 480 wide, a grid of
 * tiles 84 × 52, the agency's sections as cards). Its page classes (`wc-…`) keep the agent's styles.
 */
const CLASSES: Readonly<Record<string, string>> = {
	"body-toolbar":
		"pointer-events-auto absolute z-[3] flex items-center gap-0.5 rounded-[10px] border border-chrome-hover bg-chrome-menu p-1 text-chrome-text shadow-[0_12px_32px_rgba(0,0,0,0.35)]",
	tool: `relative grid h-8 min-w-8 place-items-center rounded-[7px] px-1 text-chrome-text hover:bg-chrome-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-45 group-data-[phone]/body:min-h-11 group-data-[phone]/body:min-w-11 [&>svg]:size-4 ${RING}`,
	drag: "cursor-grab touch-none text-chrome-muted",
	"body-notes":
		"pointer-events-none absolute z-[3] m-0 flex max-w-[22rem] list-none flex-col gap-1 rounded-lg border border-chrome-hover bg-chrome-menu px-2.5 py-1.5 text-[12px] font-medium text-chrome-warn shadow-[0_6px_16px_rgba(0,0,0,0.35)]",
	"body-drop": "pointer-events-none absolute z-[3] h-[3px] rounded-sm bg-[#4f46e5]",
	popup:
		"pointer-events-auto absolute z-[4] flex w-[380px] max-w-[calc(100%-8px)] flex-col gap-3.5 rounded-[14px] border border-chrome-hover bg-chrome-menu p-4 text-[13px] text-chrome-text shadow-[0_20px_48px_rgba(0,0,0,0.4)] has-[.chooser]:w-[480px] has-[.chooser]:gap-0 has-[.chooser]:rounded-[12px] has-[.chooser]:border-[#3f3f46] has-[.chooser]:p-2.5 [&:has(.chooser)>.panel-head]:sr-only",
	"body-panel": "max-h-[calc(100%-8px)] overflow-auto",
	"panel-head": "flex items-center gap-2.5",
	"panel-title": "m-0 min-w-0 flex-1 truncate text-[15px] font-semibold text-chrome-strong",
	"body-form": "flex flex-col gap-3.5",
	"props-form": "",
	field: "flex flex-col gap-1.5",
	"field-label": "text-[13px] font-medium text-chrome-strong",
	help: "m-0 text-[12px] text-chrome-muted empty:hidden",
	"text-input": `h-10 w-full rounded-[8px] border border-[#3f3f46] bg-chrome-raised px-3 text-[14px] text-chrome-strong placeholder:text-chrome-faint [&:is(textarea)]:h-auto [&:is(textarea)]:py-2 in-[.chooser]:h-[30px] in-[.chooser]:rounded-[7px] in-[.chooser]:border-transparent in-[.chooser]:px-2.5 in-[.chooser]:text-[12px] ${RING}`,
	"field-problem": "m-0 text-[12px] text-chrome-danger empty:hidden",
	actions: "flex justify-end gap-2",
	primary: `inline-flex h-10 items-center justify-center rounded-[9px] bg-white px-3.5 text-[13px] font-semibold text-[#121214] disabled:opacity-50 ${RING}`,
	secondary: `inline-flex h-10 items-center justify-center rounded-[9px] bg-chrome-raised px-3.5 text-[13px] font-semibold text-chrome-strong hover:bg-chrome-hover disabled:opacity-50 ${RING}`,
	small: "",
	"check-field":
		"flex min-h-10 items-center gap-2.5 text-[13px] text-chrome-strong [&>input]:size-4 [&>input]:accent-[#6366f1]",
	"media-row": "flex items-center gap-2.5",
	"media-name": "text-[13px] text-chrome-muted",
	chooser: "flex flex-col gap-2",
	"chooser-list":
		"flex max-h-[18rem] flex-col gap-2 overflow-auto [&>[data-group=components]]:border-t [&>[data-group=components]]:border-[#3f3f46] [&>[data-group=components]]:pt-2 [&>[role=group]]:flex [&>[role=group]]:flex-wrap [&>[role=group]]:gap-2",
	"chooser-group":
		"w-full text-[10px] font-semibold tracking-[0.4px] text-chrome-muted uppercase in-data-[group=blocks]:sr-only",
	"chooser-option":
		"flex h-[52px] w-[84px] cursor-default flex-col items-center justify-center gap-[5px] overflow-hidden rounded-[9px] bg-chrome-raised px-1 text-center text-[12px] leading-tight font-medium text-chrome-text hover:bg-chrome-hover aria-selected:bg-chrome-hover aria-selected:outline-2 aria-selected:outline-[#818cf8] [&>svg]:size-[18px] in-data-[group=components]:w-[222px] in-data-[group=components]:flex-row in-data-[group=components]:justify-start in-data-[group=components]:gap-2.5 in-data-[group=components]:px-2.5 in-data-[group=components]:[&>svg]:box-content in-data-[group=components]:[&>svg]:size-[15px] in-data-[group=components]:[&>svg]:shrink-0 in-data-[group=components]:[&>svg]:rounded-[7px] in-data-[group=components]:[&>svg]:bg-chrome-hover in-data-[group=components]:[&>svg]:p-[6.5px] group-data-[phone]/body:min-h-11",
	"chooser-words": "flex min-w-0 flex-col",
	"chooser-name": "truncate text-[12px] font-medium text-chrome-strong",
	"chooser-detail": "truncate text-[11px] font-normal text-chrome-muted",
	menu: "flex flex-col gap-0.5",
	"body-menu": "",
	"menu-row": `flex h-9 w-full items-center rounded-[7px] px-2.5 text-start text-[13px] text-chrome-text hover:bg-chrome-hover aria-disabled:opacity-45 ${RING}`,
	"menu-title": "truncate",
	"danger-item": "text-chrome-danger",
	"sheet-rows": "flex flex-col gap-0.5",
	"sheet-row": `flex min-h-11 w-full items-center rounded-[8px] px-3 text-start text-[14px] text-chrome-text hover:bg-chrome-hover aria-disabled:opacity-45 ${RING}`,
	"sheet-row-text": "truncate",
};

/** The "Add a Block" tool, the indigo square of `client-flows/01`. */
const ADD_TOOL = "bg-[#4f46e5]! text-white! hover:bg-[#4338ca]! [&>svg]:size-3.5!";

/** A body's name for people: its Field's label, as its chip says it. */
function bodyName(region: Element, words: Words): string {
	return region.getAttribute("data-wc-label") || nameOf(region, words);
}

/** What an event's target is in the page: an element of its realm, or nothing. */
function pageElement(view: Window | null | undefined, target: EventTarget | null): Element | null {
	const realm = view as (Window & typeof globalThis) | null | undefined;
	return realm && target instanceof realm.Element ? target : null;
}

export function bodyInPlace(options: {
	token: string;
	words: Words;
	request: EditRequests;
	/** The block editor's file (`ShellConfig.bodyEditor`). */
	src: string;
	announce(text: string, urgent?: boolean): void;
	/** A change is on its way to the Draft, saved, or refused: the bar's Draft state. */
	saving(status: SavingStatus): void;
	/** Reads the page's `state` again (its changes, for Publish and the bar). */
	refresh(): void;
}): BodyInPlace {
	const { words, request, announce } = options;
	const said = words.client.body;

	let editing: ClientEditing | null = null;
	let parts: { frame: HTMLIFrameElement; overlay: Overlay } | null = null;
	let doc: Document | null = null;
	let state: PageState | null = null;
	/** The page's state arrives after the page: the editor waits for it (its language, its words). */
	let stateArrived: (() => void) | null = null;
	let stateReady: Promise<void> = Promise.resolve();
	let mode: "edit" | "preview" = "edit";
	let tools: BodyTools | null = null;
	let layer: HTMLElement | null = null;
	let icons: HTMLElement | null = null;
	/** The body last written in: its tools in the shell's layer belong to it. */
	let lastBody: HTMLElement | null = null;
	const stops: (() => void)[] = [];

	const view = () => parts?.frame.contentWindow ?? null;
	const bodyOf = (target: EventTarget | null): HTMLElement | null =>
		(pageElement(view(), target)?.closest(BODY_REGION) as HTMLElement | null) ?? null;
	const redraw = () => parts?.overlay.schedule();

	// ── the layer: exactly over the frame's page, with its zoom ──

	const align = () => {
		const frame = parts?.frame;
		if (!layer || !frame) return;
		const geometry = frameGeometry(frame);
		layer.style.setProperty("left", `${geometry.left}px`);
		layer.style.setProperty("top", `${geometry.top}px`);
		layer.style.setProperty("width", `${frame.offsetWidth}px`);
		layer.style.setProperty("height", `${frame.offsetHeight}px`);
		layer.style.setProperty("transform", geometry.scale === 1 ? "none" : `scale(${geometry.scale})`);
		layer.toggleAttribute("data-phone", (view()?.innerWidth ?? PHONE_WIDTH + 1) <= PHONE_WIDTH);
	};

	/** A point of the shell's window in the page's coordinates. */
	const toPage = (x: number, y: number) => {
		const frame = parts?.frame;
		if (!frame) return { x, y };
		const geometry = frameGeometry(frame);
		return { x: (x - geometry.left) / geometry.scale, y: (y - geometry.top) / geometry.scale };
	};

	/** Whether a box the editor measured is one of the layer's own (the shell's window) rather than the page's. */
	const isLayerBox = (rect: DOMRectReadOnly) => {
		if (!layer) return false;
		for (const element of layer.querySelectorAll("*")) {
			const box = element.getBoundingClientRect();
			if (box.x === rect.x && box.y === rect.y && box.width === rect.width && box.height === rect.height) return true;
		}
		return false;
	};

	/**
	 * The editor's pointer events on its own tools (dragging a Block by its handle) come in the shell's
	 * coordinates: the editor reads them in the page's, as it reads the Blocks' boxes. A drag also keeps
	 * the pointer over the frame, whose page would otherwise take it.
	 */
	let catcher: HTMLElement | null = null;
	const onPointer = (event: Event) => {
		const pointer = event as PointerEvent;
		// The tools are made by the page's document (its realm), so they are no `Element` of the shell's.
		const target = pointer.target as Element | null;
		if (typeof target?.closest !== "function" || !target.closest(".body-toolbar")) return;
		const at = toPage(pointer.clientX, pointer.clientY);
		Object.defineProperty(pointer, "clientX", { value: at.x, configurable: true });
		Object.defineProperty(pointer, "clientY", { value: at.y, configurable: true });
		if (pointer.type === "pointerdown" && target.closest(".drag") && layer) {
			catcher ??= layer.ownerDocument.createElement("div");
			catcher.className = "fixed inset-0 z-[2] cursor-grabbing";
			layer.ownerDocument.body.append(catcher);
		} else if ((pointer.type === "pointerup" || pointer.type === "pointercancel") && catcher) catcher.remove();
	};

	// ── the kit the editor works through ──

	/** The editor's words: the editing bar's (`state`'s `words.body`), with client editing's own where it has them. */
	const wordOf = (key: string, values: Record<string, string | number> = {}): string => {
		const own: Record<string, string> = {
			"body.menu.placeholder": said.filter,
			"body.components.group": said.agencyMade,
		};
		let found: unknown = own[key];
		if (found === undefined) {
			found = (state as (PageState & { words?: BarWords }) | null)?.words;
			for (const part of key.split("."))
				found = found && typeof found === "object" ? (found as BarWords)[part] : undefined;
		}
		const text = typeof found === "string" ? found : key;
		return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
	};

	const chooser = (page: Document): BodyChooserLook => ({
		label: (choice) => (said.choices as Record<string, string>)[choice] ?? wordOf(`body.choices.${choice}`),
		icon(choice) {
			const found = icons?.querySelector(`[data-icon="${CSS.escape(`choice-${choice}`)}"]`);
			return found ? (page.importNode(found, true) as Element) : null;
		},
		detail: (component) =>
			component.props.length > 0
				? fill(said.fillIn, { props: component.props.map((prop) => prop.label).join(", ") })
				: said.nothingToFill,
	});

	const kitFor = (page: Document): BarKit => {
		const win = page.defaultView as Window & typeof globalThis;
		const addWord = wordOf("body.addAfter");

		const el = <Tag extends keyof HTMLElementTagNameMap>(
			tag: Tag,
			attributes: Record<string, string> = {},
			...children: (Node | string)[]
		): HTMLElementTagNameMap[Tag] => {
			// Made by the page's document: what goes into the page is of its realm, as the editor expects.
			const node = page.createElement(tag);
			for (const [name, value] of Object.entries(attributes)) {
				if (name === "class") {
					const own = value
						.split(/\s+/)
						.map((each) => CLASSES[each] ?? "")
						.filter(Boolean);
					node.setAttribute("class", [value, ...own].join(" "));
				} else node.setAttribute(name, value);
			}
			node.append(...children);
			return node;
		};
		const button = (attributes: Record<string, string>, ...children: (Node | string)[]) => {
			const made = el("button", { type: "button", ...attributes }, ...children);
			if (attributes["aria-label"] === addWord) made.className += ` ${ADD_TOOL}`;
			return made;
		};
		const icon = (name: string): SVGSVGElement => {
			const found = icons?.querySelector(`[data-icon="${CSS.escape(name)}"]`);
			if (found) return page.importNode(found, true) as SVGSVGElement;
			return page.createElementNS("http://www.w3.org/2000/svg", "svg");
		};

		const barState = (): BarState => {
			const language = state?.language ?? { code: "", name: "" };
			return {
				page: {
					title: state?.page.title ?? "",
					path: state?.page.path ?? "",
					item: state?.page.item ?? null,
					layout: false,
				},
				canPublish: false,
				canCode: false,
				person: { name: "" },
				site: { id: "", name: "" },
				language,
				defaultLanguage: state?.defaultLanguage ?? language.code,
				languages: (state?.languages ?? []).map(({ code, name, path, current }) => ({ code, name, path, current })),
			};
		};

		const call = async (action: string, body: object): Promise<Answer> => {
			const saving = action === "save";
			if (saving) options.saving("saving");
			const answer = await request(action, body);
			if (saving) options.saving(answer.ok ? "saved" : "failed");
			return answer.ok ? { ok: true, data: answer.data } : { ok: false, code: answer.code, data: answer.data };
		};

		const upload = async (file: File, folderId?: string | null): Promise<Answer> => {
			const form = new FormData();
			form.set("file", file);
			if (folderId) form.set("folderId", folderId);
			try {
				const response = await fetch("/_webcraft/edit/api/media/upload", {
					method: "POST",
					credentials: "same-origin",
					cache: "no-store",
					headers: { "x-webcraft-edit-token": options.token },
					body: form,
				});
				const data = (await response.json().catch(() => ({}))) as { code?: string };
				return response.ok ? { ok: true, data } : { ok: false, code: data.code ?? "generic" };
			} catch {
				return { ok: false, code: "network" };
			}
		};

		/** Places one of the editor's floating parts beside a box: above or below it, inside the page. */
		const place = (panel: HTMLElement, rect: DOMRect, gap: number, prefer: "above" | "below") => {
			const frame = parts?.frame;
			if (!frame) return;
			const geometry = frameGeometry(frame);
			const scale = geometry.scale || 1;
			// A box of the layer's own (a tool the menu opened from, the toolbar the notes go under) is the shell's.
			const box = isLayerBox(rect)
				? (() => {
						const at = toPage(rect.left, rect.top);
						return { left: at.x, top: at.y, width: rect.width / scale, height: rect.height / scale };
					})()
				: { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
			const own = panel.getBoundingClientRect();
			const width = own.width / scale;
			const height = own.height / scale;
			const pageWidth = frame.offsetWidth;
			const pageHeight = frame.offsetHeight;
			// The Block's tools go under it, start-aligned, as `client-flows/01` draws them on the line; its
			// notes under the tools.
			const wanted =
				panel.classList.contains("body-toolbar") || panel.classList.contains("body-notes") ? "below" : prefer;
			const above = box.top - gap - height;
			const below = box.top + box.height + gap;
			let top = wanted === "above" ? (above >= EDGE ? above : below) : below;
			if (wanted === "below" && below + height > pageHeight - EDGE && above >= EDGE) top = above;
			top = Math.max(EDGE, Math.min(top, pageHeight - height - EDGE));
			const left = Math.max(EDGE, Math.min(box.left, pageWidth - width - EDGE));
			panel.style.setProperty("left", `${left}px`);
			panel.style.setProperty("top", `${top}px`);
		};

		/** A sheet along the bottom of a phone-wide page: a title, Close, and what it holds. */
		const sheet = (sheetOptions: {
			title: string;
			from: HTMLElement | null;
			content: HTMLElement;
			onClose?(): void;
		}) => {
			const heading = el("h2", { class: "panel-title" }, sheetOptions.title);
			const close = button({ class: "tool", "aria-label": said.close, title: said.close }, icon("close"));
			const dialog = el(
				"div",
				{
					role: "dialog",
					"aria-label": sheetOptions.title,
					class: "popup",
					"data-wc-body-sheet": "",
				},
				el("div", { class: "panel-head" }, heading, close),
				sheetOptions.content,
			);
			dialog.style.setProperty("left", "0");
			dialog.style.setProperty("right", "0");
			dialog.style.setProperty("bottom", "0");
			dialog.style.setProperty("width", "auto");
			dialog.style.setProperty("max-width", "none");
			dialog.style.setProperty("border-radius", "14px 14px 0 0");
			let closed = false;
			const finish = () => {
				if (closed) return;
				closed = true;
				dialog.remove();
				sheetOptions.onClose?.();
				if (sheetOptions.from?.isConnected) sheetOptions.from.focus();
			};
			close.addEventListener("click", finish);
			dialog.addEventListener("keydown", (event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				finish();
			});
			layer?.append(dialog);
			return { close: finish, dialog: dialog as unknown as HTMLDialogElement };
		};

		const freshPage = async (): Promise<Document | null> => {
			try {
				const response = await fetch(win.location.href, {
					credentials: "same-origin",
					cache: "no-store",
					headers: { accept: "text/html" },
				});
				if (!response.ok) return null;
				return new win.DOMParser().parseFromString(await response.text(), "text/html");
			} catch {
				return null;
			}
		};

		const pickImage = async (choice: { current: string | null }): Promise<MediaChoice | null> => {
			const item = await pickMedia({ kind: "image", current: choice.current });
			if (!item) return null;
			return {
				id: item.id,
				fileName: item.fileName,
				title: item.title,
				alt: null,
				width: item.width,
				height: item.height,
				status: item.status,
				url: item.url,
				thumbnail: null,
				focalPoint: null,
				canEdit: false,
				replacing: false,
			} as MediaChoice;
		};

		/** A photo Block's picture, changed from its form: chosen in the Media picker, saved in that Block alone. */
		const openImage = async (region: HTMLElement) => {
			const item = region.getAttribute("data-wc-item");
			const field = region.getAttribute("data-wc-field");
			const block = region.getAttribute("data-wc-block");
			if (!item || !field || !block) return;
			const chosen = await pickMedia({ kind: "image", current: region.getAttribute("data-wc-media") });
			if (!chosen) return;
			options.saving("saving");
			const answer = await request("image", {
				item,
				field,
				block,
				media: chosen.id,
				language: state?.language.code,
			});
			options.saving(answer.ok ? "saved" : "failed");
			if (!answer.ok) announce(fill(words.editing.refused, { reason: answer.code }), true);
		};

		/** The page's shared Draft, its saves shown in the bar's Draft state. */
		const shared = (item: string): BarSharedDraft | null => {
			const draft = editing?.shared(item);
			if (!draft) return null;
			return {
				...draft,
				change(next) {
					const changed = draft.change(next);
					if (changed) options.saving("saving");
					return changed;
				},
				async saved() {
					const done = await draft.saved();
					options.saving(done ? "saved" : "failed");
					return done;
				},
			} as BarSharedDraft;
		};

		const kit: Omit<BarKit, "panel"> = {
			win,
			doc: page,
			send: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch,
			later: (work: () => void, delay: number) => window.setTimeout(work, delay),
			cancel: (timer: number | undefined) => window.clearTimeout(timer),
			token: options.token,
			call,
			upload,
			el,
			button,
			icon,
			word: wordOf,
			announce: (text: string) => announce(text, text === wordOf("body.saveFailed")),
			errorText: (code: string) => fill(words.editing.refused, { reason: code }),
			richText: () => [],
			problemText: (problem: { rule?: string; message?: string }) => problem.message ?? "",
			state: barState,
			refresh: async () => options.refresh(),
			layer: layer as HTMLElement,
			root: layer as unknown as ShadowRoot,
			barBottom: () => 0,
			editing: () => mode === "edit",
			phone: () => win.innerWidth <= PHONE_WIDTH,
			place,
			showTag: () => {},
			freshPage,
			// What the server renders for a Block (a photo, a video, a Component) holds no text region to adopt.
			adopt: () => {},
			placeIn: (where: { item: string; at: string } | null) => editing?.place(where?.item ?? null, where?.at ?? null),
			pageDraft: () => state?.page.item ?? null,
			sheet,
			moved: () => {},
			pickImage,
			openImage: (region: HTMLElement) => void openImage(region),
			shared,
			history: () => null,
			chooser: chooser(page),
		};
		// The editing bar's panels (`panel`) are its own parts' and the body never asks for them.
		return kit as BarKit;
	};

	// ── starting and stopping the editor with each page ──

	/** The page's bodies can be reached with Tab (as one marked area each) while editing is on. */
	const tabStops = () => {
		if (!doc) return;
		for (const region of doc.querySelectorAll<HTMLElement>(BODY_REGION)) {
			if (mode === "edit") {
				if (!region.hasAttribute("tabindex")) region.setAttribute("tabindex", "-1");
			} else if (region.getAttribute("tabindex") === "-1") region.removeAttribute("tabindex");
		}
	};

	const start = async (page: Document) => {
		const region = page.querySelector<HTMLElement>(BODY_REGION);
		if (!region || !layer) return;
		const [factory] = await Promise.all([loadBodyEditor(page, options.src), stateReady]);
		if (page !== doc || !layer) return;
		if (!factory) {
			announce(fill(said.loadFailed, { name: bodyName(region, words) }), true);
			return;
		}
		tools = factory(kitFor(page));
		tools.setUp(page);
		tools.mode(mode === "edit");
		tabStops();
		align();
		redraw();
	};

	/** The page left: what its editor drew goes, and its editor with it. */
	const drop = () => {
		try {
			tools?.mode(false);
		} catch {
			// The page it edited is gone with its realm: there is nothing left to stop.
		}
		tools = null;
		lastBody = null;
		catcher?.remove();
		layer?.replaceChildren();
	};

	/** Puts the caret in a body's first Block (Enter on the body, SPEC 13.9). */
	const startWriting = (region: HTMLElement) => {
		const first = region.querySelector<HTMLElement>("[data-wc-block-part], .wc-edit-block");
		if (!first) return;
		first.focus();
		if (!first.isContentEditable) return;
		const page = first.ownerDocument;
		const range = page.createRange();
		range.selectNodeContents(first);
		range.collapse(true);
		const selection = page.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	};

	/** Escape in a body: the tools go, focus stays on the body as a whole, which says so. */
	const finish = (region: HTMLElement) => {
		tools?.mode(false);
		tools?.mode(true);
		region.focus({ preventScroll: true });
		window.setTimeout(() => announce(fill(words.client.marks.finished, { name: bodyName(region, words) })), 0);
		redraw();
	};

	const wrap = (inner: ClientEditing): ClientEditing => {
		editing = inner;
		return {
			...inner,
			connect(next) {
				parts = next;
				stops.push(next.overlay.onDraw(align));
				const resized = () => align();
				window.addEventListener("resize", resized);
				stops.push(() => window.removeEventListener("resize", resized));
				const disconnect = inner.connect(next);
				align();
				return () => {
					disconnect();
					for (const stop of stops.splice(0)) stop();
					drop();
					parts = null;
				};
			},
			page(document, address, isPage) {
				drop();
				doc = document;
				state = null;
				stateReady = new Promise((resolve) => {
					stateArrived = resolve;
				});
				inner.page(document, address, isPage);
			},
			ready(document) {
				inner.ready(document);
				if (document !== doc) return;
				tabStops();
				void start(document);
			},
			pageState(next) {
				state = next;
				stateArrived?.();
				stateArrived = null;
				inner.pageState(next);
			},
			event(kind, event) {
				if (mode === "preview" || !doc) return inner.event(kind, event);
				const region = bodyOf(event.target);
				if (!region) return inner.event(kind, event);
				// On the body as a whole (reached with Tab): client editing arms it; Enter starts writing.
				const within = event.target !== region;
				switch (kind) {
					case "keydown": {
						const key = event as KeyboardEvent;
						const plain = !key.altKey && !key.ctrlKey && !key.metaKey && !key.shiftKey && !key.isComposing;
						if (!within) {
							if (key.key === "Enter" && plain && tools) {
								startWriting(region);
								return true;
							}
							return inner.event(kind, event);
						}
						if (key.key === "Escape" && plain) {
							finish(region);
							return true;
						}
						// Enter is the editor's (a new Block, a list's next line), never "finish".
						if (key.key === "Enter") return false;
						// Tab goes on to the next marked area; Undo and Redo stay the browser's; ⌘↵ opens Publish.
						return inner.event(kind, event);
					}
					case "focusin":
						if (!within) return inner.event(kind, event);
						// Writing in a Block: focus that came from the editor itself (a new Block) never waits for Enter.
						lastBody = region;
						redraw();
						return false;
					case "focusout":
						if (!within) return inner.event(kind, event);
						window.setTimeout(redraw, 0);
						return false;
					default:
						return inner.event(kind, event);
				}
			},
			setMode(next) {
				mode = next;
				tools?.mode(next === "edit");
				tabStops();
				inner.setMode(next);
				redraw();
			},
			destroy() {
				drop();
				inner.destroy();
			},
		};
	};

	const onFocusIn = () => redraw();
	const onFocusOut = () => window.setTimeout(redraw, 0);
	const POINTER = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const;

	return {
		wrap,
		editing() {
			const page = doc;
			const frame = parts?.frame;
			if (!page || !frame || mode === "preview") return null;
			const shell = frame.ownerDocument;
			// Focus in the body's tools (its toolbar, the Block list, a form): the body they belong to.
			if (layer?.contains(shell.activeElement) && lastBody?.isConnected) return lastBody;
			if (shell.activeElement !== frame) return null;
			const active = page.activeElement;
			const region = active?.closest<HTMLElement>(BODY_REGION) ?? null;
			return region && region !== active ? region : null;
		},
		mount(next) {
			for (const kind of POINTER) layer?.removeEventListener(kind, onPointer, true);
			layer?.removeEventListener("focusin", onFocusIn);
			layer?.removeEventListener("focusout", onFocusOut);
			if (!next) {
				drop();
				layer = null;
				icons = null;
				return;
			}
			layer = next.layer;
			icons = next.icons;
			for (const kind of POINTER) layer.addEventListener(kind, onPointer, true);
			// Focus moving among the tools: the body's marks follow (being written in, or not).
			layer.addEventListener("focusin", onFocusIn);
			layer.addEventListener("focusout", onFocusOut);
			align();
			if (doc && !tools && doc.readyState !== "loading") void start(doc);
		},
		destroy() {
			drop();
			for (const stop of stops.splice(0)) stop();
		},
	};
}
