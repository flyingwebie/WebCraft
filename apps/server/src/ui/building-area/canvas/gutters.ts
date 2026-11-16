/**
 * The canvas's size (SPEC 4 and 7): the page as a light frame on the chrome, with a 12 px grab gutter
 * left, right and below. The frame is as wide as the pane unless a gutter, a preset or the width field
 * sets a width; a width wider than the pane zooms the page out (down to 25 %), and the frame is never
 * under 320 × 320. Dragging a side gutter changes the width symmetrically.
 *
 * Pure: the sizes in, the layout out. `Frame.tsx` draws it.
 */

/** The gutter's width (left, right) and height (below), in pixels of the shell. */
export const GUTTER = 12;
/** The frame is never narrower or lower than this, in the page's own pixels. */
export const FRAME_MIN = 320;
/** The page is never zoomed out further than this. */
export const ZOOM_MIN = 0.25;

/** The presets of the size readout: Desktop is the pane's width; Tablet and Phone as the editing bar had them. */
export const PRESETS = { desktop: null, tablet: 768, phone: 390 } as const;
export type Preset = keyof typeof PRESETS;

/**
 * The size the frame was given, in the page's own pixels: null is "as the pane", for each of the two.
 */
export type FrameSize = { width: number | null; height: number | null };

export const FULL_SIZE: FrameSize = { width: null, height: null };

/** The space the frame has: the canvas less its gutters. */
export type Pane = { width: number; height: number };

export type FrameLayout = {
	/** The page's own width and height (what its media queries see). */
	pageWidth: number;
	pageHeight: number;
	/** How much the page is zoomed: 1, or less when it is wider than the pane. */
	scale: number;
	/** The frame as drawn in the shell. */
	boxWidth: number;
	boxHeight: number;
	/** Whether the frame is narrower than the pane. */
	narrower: boolean;
	/** Whether the page is zoomed out to fit. */
	zoomed: boolean;
};

/** The canvas less its gutters: what the frame has to be drawn in. */
export function paneOf(canvas: { width: number; height: number }): Pane {
	return { width: Math.max(0, canvas.width - 2 * GUTTER), height: Math.max(0, canvas.height - GUTTER) };
}

/** The widest page the pane can show (zoomed out to 25 %). */
export function widestFor(pane: Pane): number {
	return Math.max(FRAME_MIN, Math.floor(pane.width / ZOOM_MIN));
}

/** A width given by a person, held between 320 and what 25 % zoom can show. */
export function clampWidth(width: number, pane: Pane): number {
	return Math.min(widestFor(pane), Math.max(FRAME_MIN, Math.round(width)));
}

/** How the frame is drawn for a size in a pane. */
export function frameLayout(size: FrameSize, pane: Pane): FrameLayout {
	const paneWidth = Math.max(1, pane.width);
	const pageWidth = size.width === null ? Math.max(FRAME_MIN, Math.round(paneWidth)) : clampWidth(size.width, pane);
	const scale = Math.max(ZOOM_MIN, Math.min(1, paneWidth / pageWidth));
	const highest = Math.max(FRAME_MIN, Math.floor(pane.height / scale));
	const pageHeight = size.height === null ? highest : Math.min(highest, Math.max(FRAME_MIN, Math.round(size.height)));
	return {
		pageWidth,
		pageHeight,
		scale,
		boxWidth: pageWidth * scale,
		boxHeight: pageHeight * scale,
		narrower: pageWidth * scale < paneWidth - 0.5,
		zoomed: scale < 1,
	};
}

/** The preset a size matches, if any. */
export function presetOf(size: FrameSize, layout: FrameLayout): Preset | null {
	if (size.width === null) return "desktop";
	if (layout.pageWidth === PRESETS.tablet) return "tablet";
	if (layout.pageWidth === PRESETS.phone) return "phone";
	return null;
}

/** A breakpoint of the Design system: its styles apply from `width` up. */
export type Breakpoint = { name: string; width: number };

/** The breakpoint a page this wide is in: the widest one that has started, or none below the first. */
export function breakpointAt(breakpoints: readonly Breakpoint[], width: number): Breakpoint | null {
	let found: Breakpoint | null = null;
	for (const each of breakpoints) if (each.width <= width && (!found || each.width >= found.width)) found = each;
	return found;
}

/** Which gutter: the two at the sides move together (the frame stays centred), the one below on its own. */
export type GutterSide = "start" | "end" | "below";

/**
 * The size after a gutter moved by `delta` pixels of the shell from where a drag started (towards the
 * end, or down, is positive). A side gutter changes the width by twice the move, since the frame stays
 * centred; zoomed out, a pixel of the shell is more than one of the page.
 */
export function dragged(
	side: GutterSide,
	size: FrameSize,
	start: FrameLayout,
	delta: number,
	pane: Pane,
	rtl = false,
): FrameSize {
	const pageDelta = delta / start.scale;
	if (side === "below") {
		const highest = Math.max(FRAME_MIN, Math.floor(pane.height / start.scale));
		const height = Math.min(highest, Math.max(FRAME_MIN, Math.round(start.pageHeight + pageDelta)));
		return { ...size, height: height >= highest ? null : height };
	}
	// Away from the frame's middle is wider: the end gutter to the end, the start gutter to the start.
	const outward = (side === "end") !== rtl ? pageDelta : -pageDelta;
	return { ...size, width: clampWidth(start.pageWidth + 2 * outward, pane) };
}
