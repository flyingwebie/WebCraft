/**
 * What the page agent (in the frame) and the building area's shell say to each other (ADR 0037). Both
 * are on the Site's origin, so they call each other directly: the shell puts its half on the frame's
 * `<iframe>` element before the frame loads, and the agent finds it there through `frameElement`.
 */

/** The property of the shell's `<iframe>` element that holds the shell's half. */
export const AGENT_HOST_PROPERTY = "webcraftAgentHost";

/** Where the building area opens a page: this, then the page's path (as `BUILDING_AREA_PAGE_PATH`). */
export const BUILDING_PAGE_PREFIX = "/_webcraft/build/page";

/**
 * Where the stand-in for a Template or Component is (as `BUILDING_AREA_STAND_IN_PATH`): this, then the
 * document's own address in the building area (`/component/<id>`).
 */
export const BUILDING_STAND_IN_PREFIX = "/_webcraft/build/stand-in";

/** The building area's own addresses: this, then a document's address (`/page/…`, `/component/<id>`). */
export const BUILDING_PREFIX = "/_webcraft/build";

/**
 * Text and rich text regions the page agent makes editable (bodies come with a later part of the
 * building area; image and link regions are changed in popovers, BA-15). `agent/regions.ts` makes
 * them editable; the shell saves them (`canvas/regions.ts`) and edits them (`editing/`).
 */
export const TEXT_REGION =
	'[data-wc-item][data-wc-field]:not([data-wc-type="media"]):not([data-wc-type="body"]):not([data-wc-type="link"])';

/** Image regions (an `<img>` showing a media Field, or the empty element in its place), outside a body. */
export const PHOTO_REGION = '[data-wc-type="media"][data-wc-item][data-wc-field]:not([data-wc-block])';

/**
 * Body regions: the element a body's Blocks render in (BA-18). The page's block editor (the editing
 * bar's body part, loaded into the frame) makes its Blocks editable; the shell draws its tools.
 */
export const BODY_REGION = '[data-wc-type="body"][data-wc-item][data-wc-field]';

/** Link regions: an `<a>` showing a whole link Field, its address and its words. */
export const LINK_REGION = 'a[data-wc-type="link"][data-wc-item][data-wc-field]';

/** The page's events the agent hands to the shell, as the browser gave them, before any Site script sees them. */
export type AgentEventKind =
	| "pointermove"
	| "pointerdown"
	| "pointerleave"
	| "click"
	| "keydown"
	| "focusin"
	| "focusout"
	| "input"
	/** Before text changes: the browser's own Undo and Redo of text (`historyUndo`) are the shell's history's. */
	| "beforeinput"
	/** The caret or the selected text moved (on the document): the text toolbar shows what is pressed. */
	| "selectionchange"
	| "scroll"
	/** Something dragged over the page, out of an element, or dropped: a file dropped on a photo (BA-15). */
	| "dragover"
	| "dragleave"
	| "drop";

/** The shell's half, which the agent calls. */
export type AgentHost = {
	/**
	 * A page has started in the frame: its document, its address (path and query), and the agent's
	 * own half. Called once per page, before any of the page's scripts run.
	 */
	attach(agent: PageAgent, document: Document, address: string): void;
	/** The page's document is parsed (its regions are editable now). */
	ready(document: Document): void;
	/**
	 * One of the page's events, before any Site script sees it. Answers true when the shell took it
	 * (a key such as F6): the agent then stops it there.
	 */
	event(kind: AgentEventKind, event: Event): boolean;
	/** The frame's window gained or lost focus. */
	focus(inside: boolean): void;
	/**
	 * A line of the page's console (BA-11, `agent/console.ts`): what its scripts wrote with `console.*`,
	 * an uncaught exception, a promise rejected with nothing to catch it, a script that didn't load. The
	 * JS pane lists them, each against the script and line it came from when the browser says.
	 */
	log(entry: ConsoleEntry): void;
	/**
	 * One of the Site's own scripts failed in the page (BA-32, `agent/failures.ts`): the Site script,
	 * the page's script, a Library or a Component script threw or didn't load, or a Component script's
	 * call failed on a Placement. The shell says so in its notice, with Safe mode a click away.
	 */
	failed(failure: ScriptFailure): void;
	/**
	 * A link of the page was clicked while the shell lets links be followed (editing is off: the
	 * interface is hidden). The agent stops the browser following it and hands its address here; the
	 * shell opens it as the next document, or leaves it when it isn't a page of the Site. Answers
	 * whether the shell took it.
	 */
	follow(href: string): boolean;
	/** Whether links are followed now (editing is off), rather than selected. */
	following(): boolean;
};

/** The agent's half, which the shell calls. */
export type PageAgent = {
	/** The page's regions made editable, among the nodes given (and their descendants). */
	adopt(nodes: readonly Node[]): void;
	/** Whether a region is plain text (one line) or rich text. */
	isRichText(region: Element): boolean;
};

/** One line of the page's console, as the agent hands it to the shell (BA-11). */
export type ConsoleEntry = {
	level: "log" | "info" | "warn" | "error";
	/** What was written, as text (values written as JSON where they can be). */
	text: string;
	/** The address of the script it came from (an error's file), when the browser says. */
	source: string | null;
	/** Its 1-based line in that script, when the browser says. */
	line: number | null;
	/**
	 * A Component script's call that failed on a Placement (BA-32): its Component, and the Placement's
	 * root by its Structure reference (`data-wc-code`, on Staff's page; null on a Member's).
	 */
	component?: { id: string; name: string };
	placement?: string | null;
};

/**
 * One of the Site's own scripts that failed in the page (BA-32): which (`site`, `page`, a `library` by
 * its name, a `component` by its Component), what it said, and its line (0 when the browser didn't
 * say; null when the script didn't load at all).
 */
export type ScriptFailure = {
	kind: "site" | "page" | "library" | "component";
	/** A Library's or a Component's name ("" for the Site script and the page's). */
	name: string;
	componentId: string | null;
	message: string;
	line: number | null;
};
