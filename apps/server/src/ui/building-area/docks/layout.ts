/**
 * Where the building area's panels are (SPEC 2, 4 and 5; ADR 0037): three docks (left, right,
 * bottom), each with a size kept as a share of the window and its panels in order, each panel
 * collapsed to its header or switched off in the Panels menu. Pure: the docks draw it, the person's
 * editor preferences keep it (`editorLayoutSchema` in `@webcraft/core`, which this shape matches).
 *
 * Shares, not pixels, so a smaller window keeps the shape. A layout the person never changed is
 * stored as none (`null`) and drawn from the panels' own defaults.
 */

/**
 * The version of the stored shape (`EDITOR_LAYOUT_VERSION` in `@webcraft/core`; a test keeps the two
 * equal). The shell sends it with every save: a layout of another version reads as the defaults.
 */
export const LAYOUT_VERSION = 1;

export const DOCK_SIDES = ["left", "right", "bottom"] as const;

export type DockSide = (typeof DOCK_SIDES)[number];

/** A panel in a dock. */
export type PanelPlacement = {
	/** The panel's key (`layers`, `inspector`, `entry`, `component`, `html`, `css`, `js`, or a Module's own). */
	id: string;
	/** Shown as its header only. */
	collapsed?: boolean;
	/** Switched off in the Panels menu: it keeps its place for when it is switched on again. */
	hidden?: boolean;
	/** Its share of the dock's length left once headers are drawn; the panels without one share the rest. */
	share?: number;
};

/** A dock: its size and its panels, first to last (top to bottom, or start to end in the bottom dock). */
export type DockLayout = {
	/** Its share of the window's width (left, right) or height (bottom); none for its default size. */
	share?: number;
	panels: PanelPlacement[];
};

export type Layout = { docks: Record<DockSide, DockLayout> };

/** Where a panel starts, as it registers itself. */
export type PanelDefault = { id: string; dock: DockSide; collapsed?: boolean };

/** The window, as the docks' shares are taken of it. */
export type WindowSize = { width: number; height: number };

/** SPEC 4: a side dock 200 to 500 wide (314 by default), the bottom dock 40 to 700 high (266 by default). */
export const DOCK_LIMITS = {
	side: { min: 200, max: 500, initial: 314 },
	bottom: { min: 40, max: 700, initial: 266 },
} as const;

/** Space around a dock's panels and between them (SPEC 4). */
export const DOCK_PADDING = 8;
export const PANEL_GAP = 8;

/** A panel's header: 28 in a side dock, 36 in the bottom dock (SPEC 4). */
export const PANEL_HEADER = { side: 28, bottom: 36 } as const;

/** The least an open panel takes along its dock: a side panel's height, a bottom pane's width. */
export const PANEL_MIN = { side: 80, bottom: 160 } as const;

/** What the docks always leave the canvas: the 320 × 320 frame and its 12 px gutters. */
export const CANVAS_MIN = { width: 344, height: 332 } as const;

/** The rail's width and the bottom bar's height, which the docks share the window with. */
const CHROME = { rail: 48, bar: 48 } as const;

/** Shares are kept to four places: enough for a pixel on any screen, and short when stored. */
function rounded(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function limitsOf(side: DockSide) {
	return side === "bottom" ? DOCK_LIMITS.bottom : DOCK_LIMITS.side;
}

/** The window's length a dock's share is taken of: its width for a side dock, its height for the bottom one. */
function windowLength(side: DockSide, window: WindowSize): number {
	return side === "bottom" ? window.height : window.width;
}

/** A copy of a layout, nothing shared with it. */
function copy(layout: Layout): Layout {
	return {
		docks: {
			left: { ...layout.docks.left, panels: layout.docks.left.panels.map((panel) => ({ ...panel })) },
			right: { ...layout.docks.right, panels: layout.docks.right.panels.map((panel) => ({ ...panel })) },
			bottom: { ...layout.docks.bottom, panels: layout.docks.bottom.panels.map((panel) => ({ ...panel })) },
		},
	};
}

/** The layout the panels start in, as they register: each in its dock, in the order given. */
export function defaultLayout(panels: readonly PanelDefault[]): Layout {
	const layout: Layout = { docks: { left: { panels: [] }, right: { panels: [] }, bottom: { panels: [] } } };
	for (const panel of panels) {
		layout.docks[panel.dock].panels.push(panel.collapsed ? { id: panel.id, collapsed: true } : { id: panel.id });
	}
	return layout;
}

/**
 * The layout to draw: the stored one (the defaults when none), with every registered panel it doesn't
 * place added at the end of its own dock. Panels it places that aren't registered here (a Module not
 * on this Site) keep their place and simply aren't drawn.
 */
export function withPanels(stored: Layout | null, panels: readonly PanelDefault[]): Layout {
	if (!stored) return defaultLayout(panels);
	const layout = copy(stored);
	const placed = new Set(DOCK_SIDES.flatMap((side) => layout.docks[side].panels.map((panel) => panel.id)));
	for (const panel of panels) {
		if (placed.has(panel.id)) continue;
		layout.docks[panel.dock].panels.push(panel.collapsed ? { id: panel.id, collapsed: true } : { id: panel.id });
	}
	return layout;
}

/** Where a panel is: its dock and its place in it. */
export function placeOf(layout: Layout, id: string): { side: DockSide; index: number; panel: PanelPlacement } | null {
	for (const side of DOCK_SIDES) {
		const index = layout.docks[side].panels.findIndex((panel) => panel.id === id);
		const panel = layout.docks[side].panels[index];
		if (panel) return { side, index, panel };
	}
	return null;
}

/**
 * Moves a panel to a dock, before the panel `before` there (at the end when none, or when `before`
 * isn't in that dock). Every panel of the two docks it leaves and joins goes back to an equal share
 * (`docking/05`). A move to where it already is changes nothing.
 */
export function movePanel(layout: Layout, id: string, to: DockSide, before: string | null = null): Layout {
	const from = placeOf(layout, id);
	if (!from || before === id) return layout;
	const target = layout.docks[to].panels;
	const beforeIndex = before === null ? -1 : target.findIndex((panel) => panel.id === before);
	if (from.side === to) {
		const next = target[from.index + 1]?.id ?? null;
		if ((beforeIndex === -1 && from.index === target.length - 1) || (beforeIndex !== -1 && next === before)) {
			return layout;
		}
	}
	const moved = copy(layout);
	const panel = moved.docks[from.side].panels.splice(from.index, 1)[0];
	if (!panel) return layout;
	delete panel.share;
	const panels = moved.docks[to].panels;
	const at = before === null ? -1 : panels.findIndex((each) => each.id === before);
	if (at === -1) panels.push(panel);
	else panels.splice(at, 0, panel);
	for (const side of new Set([from.side, to])) {
		for (const each of moved.docks[side].panels) delete each.share;
	}
	return moved;
}

/** A panel shown as its header only, or opened again. */
export function setCollapsed(layout: Layout, id: string, collapsed: boolean): Layout {
	const at = placeOf(layout, id);
	if (!at || Boolean(at.panel.collapsed) === collapsed) return layout;
	const next = copy(layout);
	const panel = next.docks[at.side].panels[at.index];
	if (!panel) return layout;
	if (collapsed) panel.collapsed = true;
	else delete panel.collapsed;
	return next;
}

/** A panel switched off in the Panels menu (it keeps its place), or on again. */
export function setHidden(layout: Layout, id: string, hidden: boolean): Layout {
	const at = placeOf(layout, id);
	if (!at || Boolean(at.panel.hidden) === hidden) return layout;
	const next = copy(layout);
	const panel = next.docks[at.side].panels[at.index];
	if (!panel) return layout;
	if (hidden) panel.hidden = true;
	else delete panel.hidden;
	return next;
}

/** A dock's size in pixels for this window: its share of it, within its limits; its default without one. */
export function dockLength(layout: Layout, side: DockSide, window: WindowSize): number {
	const limits = limitsOf(side);
	const share = layout.docks[side].share;
	if (share === undefined) return limits.initial;
	return clamp(Math.round(share * windowLength(side, window)), limits.min, limits.max);
}

/** A dock set to `length` pixels (within its limits), kept as its share of the window. */
export function resizeDock(layout: Layout, side: DockSide, length: number, window: WindowSize): Layout {
	const limits = limitsOf(side);
	const total = windowLength(side, window);
	if (total <= 0) return layout;
	const share = clamp(rounded(clamp(Math.round(length), limits.min, limits.max) / total), 0.0001, 1);
	if (layout.docks[side].share === share) return layout;
	const next = copy(layout);
	next.docks[side].share = share;
	return next;
}

/**
 * The sizes the open docks are drawn at in this window: each dock's own length, made smaller (never
 * under its minimum) where the docks together would leave the canvas less than the 320 × 320 frame
 * and its gutters. A closed dock (null) takes nothing.
 */
export function fitDocks(
	lengths: Record<DockSide, number | null>,
	window: WindowSize,
): Record<DockSide, number | null> {
	const fitted = { ...lengths };
	const roomWide = window.width - CHROME.rail - CANVAS_MIN.width;
	const left = fitted.left ?? 0;
	const right = fitted.right ?? 0;
	const over = left + right - roomWide;
	if (over > 0 && left + right > 0) {
		// Each side gives up its part of what is over, in proportion to what it has above its minimum.
		const spare =
			(fitted.left === null ? 0 : left - DOCK_LIMITS.side.min) +
			(fitted.right === null ? 0 : right - DOCK_LIMITS.side.min);
		for (const side of ["left", "right"] as const) {
			const length = fitted[side];
			if (length === null) continue;
			const above = length - DOCK_LIMITS.side.min;
			const cut = spare > 0 ? Math.min(above, Math.ceil((over * above) / spare)) : 0;
			fitted[side] = length - cut;
		}
	}
	if (fitted.bottom !== null) {
		const roomHigh = window.height - CHROME.bar - CANVAS_MIN.height;
		fitted.bottom = Math.max(DOCK_LIMITS.bottom.min, Math.min(fitted.bottom, roomHigh));
	}
	return fitted;
}

/**
 * The open panels' shares of a dock's free length (what the headers leave), in the order given:
 * a panel's own share, and an equal part of what is left for the panels without one. They add up to 1.
 */
export function panelWeights(panels: readonly PanelPlacement[]): number[] {
	if (panels.length === 0) return [];
	const own = panels.reduce((sum, panel) => sum + (panel.share ?? 0), 0);
	const without = panels.filter((panel) => panel.share === undefined).length;
	const rest = without > 0 ? (own < 1 ? (1 - own) / without : 1 / panels.length) : 0;
	const weights = panels.map((panel) => panel.share ?? rest);
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	return weights.map((weight) => (total > 0 ? weight / total : 1 / panels.length));
}

/**
 * The separator between two open panels of a dock moved by `delta` pixels (positive: the first grows):
 * `lengths` are the open panels' lengths as drawn, in order, each kept at least `PANEL_MIN`. Every open
 * panel of the dock keeps the share it is drawn at, so the others don't move.
 */
export function resizePanels(
	layout: Layout,
	side: DockSide,
	lengths: readonly { id: string; length: number }[],
	first: string,
	delta: number,
): Layout {
	const a = lengths.findIndex((each) => each.id === first);
	const b = a + 1;
	const one = lengths[a];
	const two = lengths[b];
	if (!one || !two) return layout;
	const min = PANEL_MIN[side === "bottom" ? "bottom" : "side"];
	const pair = one.length + two.length;
	const grown = clamp(one.length + delta, Math.min(min, pair / 2), Math.max(pair - min, pair / 2));
	const sizes = lengths.map((each, index) => (index === a ? grown : index === b ? pair - grown : each.length));
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total <= 0) return layout;
	const next = copy(layout);
	for (const [index, each] of lengths.entries()) {
		const panel = next.docks[side].panels.find((placed) => placed.id === each.id);
		if (panel) panel.share = clamp(rounded((sizes[index] ?? 0) / total), 0.0001, 1);
	}
	return next;
}

/** The layout as it is stored: flags only where they are on. Null stays null (the defaults). */
export function storedLayout(layout: Layout | null): Layout | null {
	if (!layout) return null;
	const dock = (side: DockSide) => {
		const { share, panels } = layout.docks[side];
		return {
			...(share === undefined ? {} : { share }),
			panels: panels.map((panel) => ({
				id: panel.id,
				...(panel.collapsed ? { collapsed: true } : {}),
				...(panel.hidden ? { hidden: true } : {}),
				...(panel.share === undefined ? {} : { share: panel.share }),
			})),
		};
	};
	return { docks: { left: dock("left"), right: dock("right"), bottom: dock("bottom") } };
}
