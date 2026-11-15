/**
 * The page agent (ADR 0037): the first script in the `<head>` of every page shown in the building
 * area's frame, a classic script that imports nothing at run time. It runs before any of the Site's
 * scripts, so it keeps what it needs of the browser first, and registers its listeners on the window
 * in the capture phase, where no Site script can stop an event before the shell has seen it.
 *
 * It does as little as it can: makes the page's text regions editable (the caret must live in the
 * page), stops links from leaving while editing, hands the page's events to the shell, and tells the
 * shell what the frame shows. A page opened outside the frame goes into the shell instead.
 */
import {
	AGENT_HOST_PROPERTY,
	type AgentEventKind,
	type AgentHost,
	BUILDING_PAGE_PREFIX,
	BUILDING_PREFIX,
	BUILDING_STAND_IN_PREFIX,
	type PageAgent,
} from "./contract.ts";
import { pageRegions } from "./regions.ts";

((win: Window & typeof globalThis) => {
	const doc = win.document;
	const address = `${win.location.pathname}${win.location.search}`;

	// Opened at the top level (a bookmark, a link from elsewhere): the shell shows it in its frame. A
	// stand-in goes to the shell at the Template or Component it draws.
	if (win.top === win) {
		win.location.replace(
			address.startsWith(`${BUILDING_STAND_IN_PREFIX}/`)
				? `${BUILDING_PREFIX}${address.slice(BUILDING_STAND_IN_PREFIX.length)}`
				: `${BUILDING_PAGE_PREFIX}${address}`,
		);
		return;
	}

	// The shell's half, on the `<iframe>` it framed this page with. Framed by anything else (another
	// page of the Site), the agent does nothing.
	let frame: Element | null = null;
	try {
		frame = win.frameElement;
	} catch {
		return;
	}
	const host = (frame as unknown as Record<string, unknown> | null)?.[AGENT_HOST_PROPERTY] as AgentHost | undefined;
	if (!host) return;

	// What the agent uses later, kept before any Site script can change it.
	const listen = EventTarget.prototype.addEventListener;
	const setAttribute = Element.prototype.setAttribute;
	const getAttribute = Element.prototype.getAttribute;
	const matches = Element.prototype.matches;
	const closest = Element.prototype.closest;
	const querySelectorAll = Element.prototype.querySelectorAll;
	const preventDefault = Event.prototype.preventDefault;
	const stopImmediatePropagation = Event.prototype.stopImmediatePropagation;
	const execCommand = Document.prototype.execCommand;
	const Observer = win.MutationObserver;

	// The page's text regions: made editable, and the rules typing in them follows (`regions.ts`).
	const regions = pageRegions(win, {
		setAttribute,
		getAttribute,
		matches,
		closest,
		querySelectorAll,
		preventDefault,
		execCommand,
	});
	const { adopt, isRichText } = regions;

	const agent: PageAgent = { adopt, isRichText };
	host.attach(agent, doc, address);

	const forward = (kind: AgentEventKind) =>
		function (this: unknown, event: Event) {
			// A link never leaves the page by itself (the shell opens pages, so Back and the address follow
			// them): while editing it is selected, and while editing is off the shell opens where it goes.
			// Typing in a region follows its rules first (plain text is one line).
			if (kind === "click" && event.target instanceof win.Element) {
				const link = closest.call(event.target, "a[href], area[href]");
				if (link) {
					preventDefault.call(event);
					const href = (link as HTMLAnchorElement).href;
					if (host.following() && typeof href === "string" && host.follow(href)) {
						stopImmediatePropagation.call(event);
						return;
					}
				}
			}
			if (kind === "keydown") regions.rules("keydown", event);
			if (host.event(kind, event)) {
				preventDefault.call(event);
				stopImmediatePropagation.call(event);
			}
		};
	for (const kind of [
		"pointermove",
		"pointerdown",
		"click",
		"keydown",
		"focusin",
		"focusout",
		"input",
		"beforeinput",
		"scroll",
		"dragover",
		"dragleave",
		"drop",
	] as const) {
		listen.call(win, kind, forward(kind), { capture: true, passive: kind === "pointermove" || kind === "scroll" });
	}
	listen.call(doc.documentElement, "pointerleave", forward("pointerleave"), { capture: false });
	// What is pasted into plain text is text only (the page sees nothing of it but the text).
	listen.call(win, "paste", (event: Event) => regions.rules("paste", event), { capture: true });
	// Where the caret is, for the text toolbar's pressed tools: the document says, not the window.
	listen.call(doc, "selectionchange", forward("selectionchange"));
	listen.call(win, "focus", () => host.focus(true));
	listen.call(win, "blur", () => host.focus(false));
	// The page's errors, for the JS pane: from the start, before any Site script runs.
	listen.call(
		win,
		"error",
		(event: Event) => {
			if (event instanceof win.ErrorEvent) host.error(event.message, event.filename || null);
			else if (event.target instanceof win.HTMLScriptElement) host.error("load", event.target.src || null);
		},
		{ capture: true },
	);

	const start = () => {
		adopt([doc.body]);
		// Regions in parts of the page shown later (a Filter's results, a Site script's own) are made
		// editable as they come.
		new Observer((records) => adopt(records.flatMap((record) => [...record.addedNodes]))).observe(doc.body, {
			childList: true,
			subtree: true,
		});
		host.ready(doc);
	};
	if (doc.readyState === "loading") listen.call(doc, "DOMContentLoaded", start, { once: true });
	else start();
})(window as Window & typeof globalThis);
