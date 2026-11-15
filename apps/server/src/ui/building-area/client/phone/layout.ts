import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Client editing at every width (SPEC 13.9, BA-19). Only the window's width counts, checked as it
 * changes; no device is detected:
 * - up to 640 px, the phone: one bar at the bottom, everything else in "More", panels and popovers as
 *   sheets from the bottom, the page edge to edge;
 * - from 641 to 1023 px, the tablet: the desktop shell, its bar keeping only the words it needs;
 * - from 1024 px, the desktop shell as it is.
 * Whatever the width, a coarse pointer (a finger) gets targets of at least 44 px (`phone.css`).
 */
export const CLIENT_WIDTHS = { phone: 640, desktop: 1024 } as const;

export type ClientLayout = "phone" | "tablet" | "desktop";

/** The layout for a window this wide. */
export function clientLayoutOf(width: number): ClientLayout {
	if (width <= CLIENT_WIDTHS.phone) return "phone";
	return width < CLIENT_WIDTHS.desktop ? "tablet" : "desktop";
}

function subscribeWidth(changed: () => void): () => void {
	// The two widths that change the layout; a resize between them changes nothing.
	const queries = [
		window.matchMedia(`(max-width: ${CLIENT_WIDTHS.phone}px)`),
		window.matchMedia(`(min-width: ${CLIENT_WIDTHS.desktop}px)`),
	];
	for (const query of queries) query.addEventListener("change", changed);
	return () => {
		for (const query of queries) query.removeEventListener("change", changed);
	};
}

/** Client editing's layout, following the window's width live (the desktop one while rendered on the server). */
export function useClientLayout(): ClientLayout {
	return useSyncExternalStore(
		subscribeWidth,
		() => clientLayoutOf(window.innerWidth),
		() => "desktop" as const,
	);
}

/**
 * How much of the window the on-screen keyboard covers at its bottom: what the visual viewport leaves
 * out below it. 0 without a keyboard, or where the browser shrinks the window for it instead.
 */
export function keyboardInset(): number {
	const visual = window.visualViewport;
	if (!visual) return 0;
	return Math.max(0, Math.round(window.innerHeight - (visual.offsetTop + visual.height)));
}

/** The keyboard's inset (`keyboardInset`), following the visual viewport as the keyboard comes and goes. */
export function useKeyboardInset(on: boolean): number {
	const [inset, setInset] = useState(0);
	useEffect(() => {
		const visual = window.visualViewport;
		if (!on || !visual) {
			setInset(0);
			return;
		}
		const measure = () => setInset(keyboardInset());
		measure();
		visual.addEventListener("resize", measure);
		visual.addEventListener("scroll", measure);
		window.addEventListener("resize", measure);
		return () => {
			visual.removeEventListener("resize", measure);
			visual.removeEventListener("scroll", measure);
			window.removeEventListener("resize", measure);
		};
	}, [on]);
	return inset;
}

/** The space kept between what is being edited and a sheet or a toolbar under it. */
const KEEP_GAP = 12;

/**
 * Scrolls the page in the frame so that `element` (in the page) ends above `top` (a line of the
 * shell's window: the top of a sheet or of the toolbar on the keyboard), never past the element's
 * own top: nothing the person is changing stays covered (SPEC 13.9, the owner's "nothing covering
 * what is being edited"). Does nothing when it already shows, or when the page can't scroll.
 */
export function keepAbove(element: Element | null | undefined, top: number): void {
	const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
	const page = frame?.contentWindow;
	if (!frame || !page || !element?.isConnected || element.ownerDocument !== frame.contentDocument) return;
	const outer = frame.getBoundingClientRect();
	const scale = frame.offsetWidth > 0 ? outer.width / frame.offsetWidth : 1;
	const box = element.getBoundingClientRect();
	const elementTop = outer.top + box.top * scale;
	const elementBottom = outer.top + box.bottom * scale;
	const over = elementBottom + KEEP_GAP - top;
	if (over <= 0) return;
	// Never so far that the element's top goes above the frame's.
	const room = Math.max(0, elementTop - outer.top - KEEP_GAP);
	const by = Math.min(over, room) / scale;
	if (by > 0) page.scrollBy({ top: by, behavior: "instant" as ScrollBehavior });
}
