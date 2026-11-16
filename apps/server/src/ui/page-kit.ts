import type { DraftClient } from "@webcraft/core/draft-document";
import type { HistoryTarget } from "./editor/commands.ts";

/**
 * What the building area hands the parts that run in the page's own realm (the block editor, ADR 0037
 * › BA-18) and the Page layout's controller (BA-17): the browser functions kept before any Site script
 * ran, the person's words, the edit requests and the shared Drafts. It began as the editing bar's kit
 * (ADR 0022), which those parts were first written against. Types only.
 */

export type Words = { [key: string]: string | Words };

/** An edit request's answer: its JSON, or the refusal's code. */
export type Answer = { ok: true; data: unknown } | { ok: false; code: string; data?: unknown };

/** A Site's image as the popover's Media library lists it (`EditMediaItem` on the server). */
export type MediaChoice = {
	id: string;
	fileName: string;
	title: string | null;
	alt: string | null;
	width: number | null;
	height: number | null;
	status: "processing" | "ready" | "failed";
	url: string | null;
	thumbnail: string | null;
	focalPoint: { x: number; y: number } | null;
	canEdit: boolean;
	replacing: boolean;
};

/** One of the Site's languages, as the page state lists them. */
export type PageLanguage = { code: string; name: string; path: string; current: boolean };

/** What the bar knows of the page, as the `state` edit request answers it (the parts' view of it). */
export type BarState = {
	page: { title: string; path: string; item: string | null; layout: boolean };
	canPublish: boolean;
	canCode: boolean;
	person: { name: string };
	site: { id: string; name: string };
	language: { code: string; name: string };
	defaultLanguage: string;
	languages: PageLanguage[];
};

/** Where someone is in the page's shared Drafts (Co-editing): the Draft (`entry:<id>`, `globals`) and the place in it. */
export type PresencePlace = { item: string; at: string };

/** Something on the page others can be in, which gets their outline: an element (or a range of nodes) and its place. */
export type PresenceTarget = PresencePlace & { rect(): DOMRect | null; outline?: HTMLElement };

export type BarKit = {
	win: Window;
	doc: Document;
	/** `fetch`, kept before any Site script ran. */
	send: typeof fetch;
	later(work: () => void, delay: number): number;
	cancel(timer: number | undefined): void;
	/** The Edit mode session's header token, which every edit request carries. */
	token: string;
	/** Sends an edit request (`POST /_webcraft/edit/api/<action>`, JSON). */
	call(action: string, body: object): Promise<Answer>;
	/** Uploads a file to the Site's Media library (`media/upload`). */
	upload(file: File, folderId?: string | null): Promise<Answer>;
	el<Tag extends keyof HTMLElementTagNameMap>(
		tag: Tag,
		attributes?: Record<string, string>,
		...children: (Node | string)[]
	): HTMLElementTagNameMap[Tag];
	button(attributes: Record<string, string>, ...children: (Node | string)[]): HTMLButtonElement;
	icon(name: string): SVGSVGElement;
	/** A word in the person's Admin language, with `{name}` values filled in. */
	word(key: string, values?: Record<string, string | number>): string;
	/** Says something in the bar's live region. */
	announce(text: string): void;
	/**
	 * Where the Page layout's controller says what it did (or what was refused, `urgent`): the building
	 * area's shell (BA-17) has its own live region; without it, the page's editor regions say it.
	 */
	say?(text: string, urgent: boolean): void;
	/** A refusal's code in words. */
	errorText(code: string): string;
	/**
	 * Rich text as nodes to show in the bar: only formatting, lists and links to addresses a page may
	 * link to are kept (the server cleans it the same way as it saves it).
	 */
	richText(html: string): Node[];
	/** A value's problem in words, by its rule. */
	problemText(problem: { rule?: string; message?: string }): string;
	/** The page's state as the server last said it. */
	state(): BarState;
	/** Reads the page's state again (its changes for the Publish menu). */
	refresh(): Promise<void>;
	/** The element inside the bar's shadow root where parts put what they show. */
	layer: HTMLElement;
	root: ShadowRoot;
	/** Where the bar ends, down the window: nothing may hide under it. */
	barBottom(): number;
	/** Whether editing in place is on (Edit, not Preview, Code mode or after Edit mode ended). */
	editing(): boolean;
	/** Whether the page is shown at a phone's width: bottom sheets instead of popovers. */
	phone(): boolean;
	/** Places a floating element next to `rect`: above it when there is room below the bar, else below. */
	place(panel: HTMLElement, rect: DOMRect, gap: number, prefer: "above" | "below"): void;
	/** Shows the region's label tag over it (`{label} · {type}`), or hides it with null. */
	showTag(target: HTMLElement | DOMRect | null, text?: string): void;
	/**
	 * The page as Edit mode shows it now, read again from the server (its Drafts as they are saved),
	 * for a part to take an updated piece of it from; null when it can't be read.
	 */
	freshPage(): Promise<Document | null>;
	/** Makes the editable regions inside new nodes editable, as the bar does at the start (text and images). */
	adopt(nodes: readonly Node[]): void;
	/** Says where the person is in the page's shared Drafts (Co-editing), or nowhere. */
	placeIn(place: PresencePlace | null): void;
	/** The Draft presence on Loop items goes through: the page's Entry's, else the Globals'; null when the page has neither. */
	pageDraft(): string | null;
	/** Shows a panel as a bottom sheet (`<dialog>`, modal) with a title, returning focus to `from` when it closes. */
	sheet(options: { title: string; from: HTMLElement | null; content: HTMLElement; onClose?(): void }): {
		close(): void;
		dialog: HTMLDialogElement;
	};
	/**
	 * One of the bar's own floating popovers or drawers (the image popover, a Loop item's form, Page
	 * details): a dialog with a title and close button, closed with Escape, its own close button, or
	 * (a phone) the bottom sheet's own dismissal, with focus going back through `focusBack` however it
	 * closed. `anchor` makes it float next to an element, tracked as the page scrolls; without one it is
	 * a static panel instead (Page details' drawer, with `htmlClass` making room for it).
	 */
	panel(options: PanelOptions): PanelHandle;
	/**
	 * The page is at another path now (a never-published page's slug changed in Page details): the
	 * address bar and the bar's own requests follow it.
	 */
	moved(path: string): void;
	/** Lets the person choose an image of the Site's Media library, or upload one; null when they choose none. */
	pickImage(options: { title: string; current: string | null; from: HTMLElement | null }): Promise<MediaChoice | null>;
	/** Opens the image popover for an image region (a part's own image regions open it too). */
	openImage?(region: HTMLElement): void;
	/** One of the page's shared Drafts (`entry:<id>`, `globals`), once it is open; null before or without it. */
	shared(item: string): SharedDraft | null;
	/** Edit mode's Undo history, once its owner handed it over (`webcraft:edit-history`); null before or without one. */
	history(): EditHistory | null;
	/**
	 * How the block editor's `/` menu draws its choices, when its host draws them as tiles (the building
	 * area's client editing, BA-18): each choice's words and icon, and a Component's line under its name.
	 * Without it the menu is a list of names.
	 */
	chooser?: BodyChooserLook;
};

/** What `BarKit.chooser` gives the block editor's `/` menu. */
export type BodyChooserLook = {
	/** A Block choice's words on its tile (`paragraph`, `heading2`, `image`, …), by the choice's id. */
	label(choice: string): string;
	/** The icon of a Block choice (by its id) or of a Component (`component`). */
	icon(choice: string): Element | null;
	/** The line under a Component's name: what it asks for. */
	detail(component: { name: string; props: readonly { label: string }[] }): string;
};

/**
 * Edit mode's Undo history (ADR 0036) as the bar, the Command menu and the keys use it: the one
 * history's target (Undo, Redo, whether each can run, the step each would take), whose Undo and Redo
 * first finish what the person is still typing. The bar hands it on as the `detail` of a
 * `webcraft:edit-history` event on the document once the history's module is mounted (null takes it
 * away), and keeps it for parts that load later (`BarKit.history`).
 */
export type EditHistory = HistoryTarget & {
	/** Called when availability or labels change; answers what stops it. */
	subscribe(listener: () => void): () => void;
};

/**
 * One of the page's shared Drafts (Co-editing, ADR 0025), as a part changes it: what its copy holds
 * (the Draft as its document does: values by key and language), a change made at once and sent with
 * the next batch, and others' changes as they come.
 */
export type SharedDraft = {
	stage: DraftClient["stage"];
	/** Whether it has the server's document yet (nothing can be changed before). */
	ready(): boolean;
	draft(): unknown;
	/** Changes the Draft to what `next` makes of it; false while it can't be changed (read-only, not ready). */
	change(next: (current: unknown) => unknown): boolean;
	/** Hears changes others make; answers what stops hearing them. */
	listen(listener: (draft: unknown) => void): () => void;
	/** Sends what is waiting and waits (a few seconds at most) until the server saved it; false if it didn't. */
	saved(): Promise<boolean>;
	/**
	 * Takes back (or makes again) one of the person's own steps in this Draft, as the Undo history asks:
	 * only what the step changed, on the Draft as it is now, saved like any other change. The page then
	 * shows it, as it shows someone else's change.
	 */
	reverse: DraftClient["reverse"];
};

/** What `kit.panel` takes: everything the mechanic needs but what the caller's own panel differs in. */
export type PanelOptions = {
	/** The dialog's accessible name, and the phone sheet's title. */
	title: string;
	/** The head's icon on desktop (a phone sheet has no head of its own: `kit.sheet` draws its own). */
	headIcon: string;
	/** The panel's classes on desktop (e.g. `"popup dialog image-popover"`, or `"drawer"` for a static one); a phone sheet is always `"sheet-body"`. */
	className: string;
	/** The body: appended after the built-in head on desktop, or on its own on a phone sheet. */
	content(phone: boolean): (Node | string)[];
	/** Where it floats, read again on every reposition; omitted for a static panel (Page details' drawer). */
	anchor?(): DOMRect;
	/** The gap from `anchor`'s rect, and which side it prefers; see `kit.place`. Defaults: 8, `"below"`. */
	gap?: number;
	prefer?: "above" | "below";
	/** A class toggled on the root element while it is open on desktop (Page details makes room for its drawer). */
	htmlClass?: string;
	/** The caller's own teardown (cancel its timers): run once, before anything closes. */
	onClose?(): void;
	/** The caller's own work after it has closed (a Loop's item form refreshes the Loop if it changed). */
	afterClose?(): void;
	/** Where focus goes back to when closing with it true (checking `isConnected`, or falling back, is the caller's own). */
	focusBack(): void;
};

/** What `kit.panel` hands back. */
export type PanelHandle = {
	/** The panel element, already in the page: the caller's own job to focus it (or a control inside
	 * it) and to add anything else of its own, such as the image popover's focusout listener. */
	panel: HTMLElement;
	/** Closes it once (a second call is a no-op): the caller's own teardown, then it leaves the page
	 * (its sheet, if a phone made it one, or itself), then, with `returnFocus`, `focusBack`. */
	close(returnFocus: boolean): void;
	/** Moves a floating panel (one with an `anchor`) to where its anchor is now; does nothing for a static one or a phone sheet. */
	reposition(): void;
};

/** What the body part (the block editor in Edit mode, #79) gives the bar back. */
export type BodyTools = {
	/** Makes the body regions inside `scope` editable Block by Block (again after a part of the page changed). */
	setUp(scope: ParentNode): void;
	/** Edit turned on or off (Preview, Edit mode ended): the bodies stop or start being edited. */
	mode(on: boolean): void;
	/** The bodies others may be in. */
	targets(): PresenceTarget[];
	/** Closes what is open (Escape outside, another panel opening). */
	close(): void;
};
