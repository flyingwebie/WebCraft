import { useRef, useSyncExternalStore } from "react";

/**
 * How wide a window Code mode and the Builder need (#126): from `full` the three-sided layout, from
 * `min` the tree and the Inspector as drawers over the page, and below `min` neither (a notice says so).
 * Only the window's width counts, checked as it changes: no device is detected.
 */
export const EDITOR_WIDTHS = { min: 1024, full: 1280 } as const;

/** The three-sided layout, or the tree and the Inspector as drawers. */
export type EditorLayout = "full" | "drawers";
/** The layout an editor shows, and whether a notice covers it because the window is too narrow. */
export type EditorFit = { layout: EditorLayout; covered: boolean };
/** A drawer of the drawer layout: the tree (with the insert toolbar) or the Inspector. */
export type EditorDrawer = "layers" | "inspector";

/**
 * The fit for a window this wide. Below `min` the editor is covered and keeps the layout it had, so
 * widening shows it again exactly as it was (the drawer layout when it opened covered).
 *
 * Self-contained: Code mode's script, served as a file made of function sources, gets it the same way.
 */
export function editorFit(width: number, widths: { min: number; full: number }, before: EditorFit | null): EditorFit {
	if (width < widths.min) return { layout: before?.layout ?? "drawers", covered: true };
	return { layout: width >= widths.full ? "full" : "drawers", covered: false };
}

/**
 * The drawer F6 opens next in the drawer layout: the tree, then the Inspector, then none (focus goes
 * back where it was); Shift+F6 goes the other way.
 *
 * Self-contained, like `editorFit`.
 */
export function nextDrawer(open: "layers" | "inspector" | null, backwards: boolean): "layers" | "inspector" | null {
	const order = [null, "layers", "inspector"] as const;
	const at = order.indexOf(open);
	return order[(at + (backwards ? order.length - 1 : 1)) % order.length] ?? null;
}

function widthNow(): number {
	return window.innerWidth;
}

function subscribe(changed: () => void): () => void {
	// The two widths that change the layout; a resize between them changes nothing.
	const queries = [EDITOR_WIDTHS.min, EDITOR_WIDTHS.full].map((width) => window.matchMedia(`(min-width: ${width}px)`));
	for (const query of queries) query.addEventListener("change", changed);
	return () => {
		for (const query of queries) query.removeEventListener("change", changed);
	};
}

/** Which of the three bands the window is in now. */
function band(): "full" | "drawers" | "narrow" {
	const width = widthNow();
	return width >= EDITOR_WIDTHS.full ? "full" : width >= EDITOR_WIDTHS.min ? "drawers" : "narrow";
}

/** The editor's fit, following the window's width live (the full layout while rendered on the server). */
export function useEditorFit(): EditorFit {
	const now = useSyncExternalStore(subscribe, band, () => "full" as const);
	const last = useRef<EditorFit | null>(null);
	const width = now === "full" ? EDITOR_WIDTHS.full : now === "drawers" ? EDITOR_WIDTHS.min : EDITOR_WIDTHS.min - 1;
	const fit = editorFit(width, EDITOR_WIDTHS, last.current);
	if (last.current?.layout !== fit.layout || last.current.covered !== fit.covered) last.current = fit;
	return last.current;
}

/**
 * Moves focus into a drawer as it opens: the tree's one tabbable row, else the chosen tab, else the
 * first control, else the drawer itself.
 *
 * Self-contained, like `editorFit`.
 */
export function focusInto(container: HTMLElement | null): void {
	if (!container) return;
	const target =
		container.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
		container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
		container.querySelector<HTMLElement>(
			'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
		);
	(target ?? container).focus();
}
