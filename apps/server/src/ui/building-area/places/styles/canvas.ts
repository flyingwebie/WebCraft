import { useSyncExternalStore } from "react";

import { redrawCanvas } from "../../canvas/redraw.ts";

/**
 * What the Styles place hands the canvas, which stays mounted under it (BA-20): the Breakpoints
 * switched on with "Show on canvas" (`places-assets/07`), drawn as lines over the frame where its edges
 * would be at each width; and, once the place has changed the Design system's Draft in this tab, the
 * Draft's stylesheet in place of the published one on every page the frame shows, so a token changed
 * here (a colour's dark value, in Dark preview) shows on the page.
 */

/** A Breakpoint shown on the canvas: its line is where the frame's edges are at its width. */
export type ShownBreakpoint = { id: string; name: string; width: number };

const KEY = "webcraft.building.breakpoints";
let shown: readonly ShownBreakpoint[] = readStored();
const listeners = new Set<() => void>();

/** The switches as this tab left them (kept for the tab: a reload keeps them, a new tab starts with none). */
function readStored(): readonly ShownBreakpoint[] {
	try {
		const stored = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as unknown;
		if (!Array.isArray(stored)) return [];
		return stored.filter(
			(each): each is ShownBreakpoint =>
				typeof each?.id === "string" && typeof each?.name === "string" && typeof each?.width === "number",
		);
	} catch {
		return [];
	}
}

function changed(next: readonly ShownBreakpoint[]): void {
	shown = next;
	try {
		sessionStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		// Kept in memory only.
	}
	for (const listener of listeners) listener();
}

/** Switches a Breakpoint's line on the canvas on or off. */
export function showBreakpoint(breakpoint: ShownBreakpoint, on: boolean): void {
	const others = shown.filter((each) => each.id !== breakpoint.id);
	changed(on ? [...others, breakpoint] : others);
}

/** Keeps the shown Breakpoints in step with the Design system (renamed, moved or removed). */
export function followBreakpoints(breakpoints: readonly ShownBreakpoint[]): void {
	const next = shown.flatMap((each) => {
		const found = breakpoints.find((breakpoint) => breakpoint.id === each.id);
		return found ? [{ id: found.id, name: found.name, width: found.width }] : [];
	});
	if (JSON.stringify(next) !== JSON.stringify(shown)) changed(next);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The Breakpoints shown on the canvas, narrowest first. */
export function useShownBreakpoints(): readonly ShownBreakpoint[] {
	return useSyncExternalStore(subscribe, () => shown);
}

/** The frame the canvas shows its page in (BA-01). */
export function canvasFrame(): HTMLIFrameElement | null {
	return document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
}

/** How wide the page in the frame is now, in CSS pixels (null while there is no page). */
export function canvasWidth(): number | null {
	const frame = canvasFrame();
	const width = frame?.contentWindow?.innerWidth;
	return width && width > 0 ? width : null;
}

/** Where the Site's published stylesheet is served, and where Edit mode serves the Draft's. */
const PUBLISHED_STYLESHEET = "/_wc/css/";
const DRAFT_STYLESHEET = "/_webcraft/edit/css/";

let draftShown = false;
let draftVersion = 0;
const watched = new WeakSet<HTMLIFrameElement>();

/** Points the page's stylesheet at the Design system's Draft, read again (a new name each time). */
function pointAtDraft(frame: HTMLIFrameElement): void {
	let page: Document | null = null;
	try {
		page = frame.contentDocument;
	} catch {
		return;
	}
	if (!page) return;
	for (const link of page.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
		const href = link.getAttribute("href") ?? "";
		if (href.startsWith(PUBLISHED_STYLESHEET) || href.startsWith(DRAFT_STYLESHEET)) {
			link.setAttribute("href", `${DRAFT_STYLESHEET}styles-${draftVersion}.css`);
		}
	}
}

/**
 * The Design system's Draft changed here: the page in the frame shows it from now on (this page, and
 * each page the frame shows after it in this tab).
 */
export function showDraftStyles(): void {
	draftShown = true;
	draftVersion++;
	const frame = canvasFrame();
	if (!frame) return;
	if (!watched.has(frame)) {
		watched.add(frame);
		frame.addEventListener("load", () => {
			if (draftShown) pointAtDraft(frame);
		});
	}
	pointAtDraft(frame);
}

/**
 * A Class renamed: its elements carry the new name in the Draft Structure, so the page in the frame is
 * drawn again in place at once (BA-08's `rerender()`, scroll and selection kept), then shown with the
 * Draft's stylesheet, which has the rule under the new name.
 */
export async function redrawWithDraftStyles(): Promise<void> {
	await redrawCanvas(canvasFrame());
	showDraftStyles();
}
