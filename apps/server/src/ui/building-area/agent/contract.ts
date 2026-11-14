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
 * Text and rich text regions the page agent makes editable (image regions and bodies come with
 * later parts of the building area). `agent/regions.ts` makes them editable; the shell saves them
 * (`canvas/regions.ts`) and edits them (`editing/`).
 */
export const TEXT_REGION = '[data-wc-item][data-wc-field]:not([data-wc-type="media"]):not([data-wc-type="body"])';

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
	| "scroll";

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
	/** An error the page reported (an uncaught exception, a script that didn't load). */
	error(message: string, source: string | null): void;
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
