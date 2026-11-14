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
	type PageAgent,
	TEXT_REGION,
} from "./contract.ts";

((win: Window & typeof globalThis) => {
	const doc = win.document;
	const address = `${win.location.pathname}${win.location.search}`;

	// Opened at the top level (a bookmark, a link from elsewhere): the shell shows it in its frame.
	if (win.top === win) {
		win.location.replace(`${BUILDING_PAGE_PREFIX}${address}`);
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
	const Observer = win.MutationObserver;

	/** How text regions are made editable: `plaintext-only` for plain text where the browser has it. */
	const plainTextOnly = (() => {
		try {
			const probe = doc.createElement("div");
			probe.contentEditable = "plaintext-only";
			return probe.contentEditable === "plaintext-only";
		} catch {
			return false;
		}
	})();

	const isRichText = (region: Element) => getAttribute.call(region, "data-wc-type") === "richText";

	const adopt = (nodes: readonly Node[]) => {
		for (const node of nodes) {
			if (!(node instanceof win.Element)) continue;
			const found = [...(matches.call(node, TEXT_REGION) ? [node] : []), ...querySelectorAll.call(node, TEXT_REGION)];
			for (const region of found) {
				if (getAttribute.call(region, "contenteditable") !== null) continue;
				setAttribute.call(region, "contenteditable", isRichText(region) || !plainTextOnly ? "true" : "plaintext-only");
				setAttribute.call(region, "spellcheck", "true");
			}
		}
	};

	const agent: PageAgent = { adopt, isRichText };
	host.attach(agent, doc, address);

	const forward = (kind: AgentEventKind) =>
		function (this: unknown, event: Event) {
			// Editing: a link never leaves the page (the shell opens pages), and plain text is one line.
			if (
				kind === "click" &&
				event.target instanceof win.Element &&
				closest.call(event.target, "a[href], area[href]")
			) {
				preventDefault.call(event);
			}
			if (
				kind === "keydown" &&
				(event as KeyboardEvent).key === "Enter" &&
				event.target instanceof win.Element &&
				matches.call(event.target, TEXT_REGION) &&
				!isRichText(event.target)
			) {
				preventDefault.call(event);
			}
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
		"scroll",
	] as const) {
		listen.call(win, kind, forward(kind), { capture: true, passive: kind === "pointermove" || kind === "scroll" });
	}
	listen.call(doc.documentElement, "pointerleave", forward("pointerleave"), { capture: false });
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
