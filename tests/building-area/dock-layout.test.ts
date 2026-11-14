// The building area's dock layout (BA-05; SPEC 4 and 5): the pure model the docks draw and the
// person's editor preferences keep.
// - the defaults: the right dock with Layers, the Inspector and Entry (collapsed), HTML, CSS and JS
//   in the bottom dock, the Component panel on the left; each dock at its default size;
// - a move puts the panel where it was dropped, and every panel of the two docks back to an equal
//   share; a move to where the panel already is changes nothing;
// - collapsing and switching off keep the panel's place; nothing else moves;
// - sizes are kept as shares of the window, within the limits (side 200–500, bottom 40–700), so a
//   smaller window keeps the shape; the docks together always leave the canvas its 320 × 320 frame;
// - a separator between two panels shares their length and leaves the others where they are;
// - every layout the model makes is one the stored shape accepts, and its version is the stored one;
// - the shell starts from the layout the person keeps (their editor preferences), or none.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EDITOR_LAYOUT_VERSION, editorLayoutSchema } from "@webcraft/core";

import {
	CANVAS_MIN,
	DOCK_LIMITS,
	defaultLayout,
	dockLength,
	fitDocks,
	LAYOUT_VERSION,
	type Layout,
	movePanel,
	PANEL_MIN,
	panelWeights,
	placeOf,
	resizeDock,
	resizePanels,
	setCollapsed,
	setHidden,
	storedLayout,
	withPanels,
} from "../../apps/server/src/ui/building-area/docks/layout.ts";
import { PANELS, type PanelContext } from "../../apps/server/src/ui/building-area/docks/panels.ts";
import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const WINDOW = { width: 1440, height: 900 };
const ids = (layout: Layout, side: "left" | "right" | "bottom") => layout.docks[side].panels.map((panel) => panel.id);
const defaults = () => defaultLayout(PANELS);

/** Whether the stored shape (`editorLayoutSchema`, BA-03) takes a layout as the model makes it. */
function storable(layout: Layout): boolean {
	return editorLayoutSchema.safeParse(storedLayout(layout)).success;
}

describe("the dock layout", () => {
	test("its version is the stored shape's", () => {
		expect(LAYOUT_VERSION).toBe(EDITOR_LAYOUT_VERSION);
	});

	test("starts with the defaults of SPEC 5: right Layers, Inspector, Entry collapsed; bottom HTML, CSS, JS; left the Component", () => {
		const layout = defaults();
		expect(ids(layout, "right")).toEqual(["layers", "inspector", "entry"]);
		expect(placeOf(layout, "entry")?.panel.collapsed).toBe(true);
		expect(placeOf(layout, "layers")?.panel.collapsed).toBeUndefined();
		expect(ids(layout, "bottom")).toEqual(["html", "css", "js"]);
		expect(ids(layout, "left")).toEqual(["component"]);
		expect(dockLength(layout, "right", WINDOW)).toBe(314);
		expect(dockLength(layout, "left", WINDOW)).toBe(314);
		expect(dockLength(layout, "bottom", WINDOW)).toBe(266);
		expect(storable(layout)).toBe(true);
	});

	test("draws the stored layout, adding at their own dock's end the panels it doesn't place, keeping the ones not registered", () => {
		const stored: Layout = {
			docks: {
				left: { panels: [{ id: "layers" }] },
				right: { share: 0.25, panels: [{ id: "m.forms.fields" }, { id: "inspector" }] },
				bottom: { panels: [] },
			},
		};
		const layout = withPanels(stored, PANELS);
		expect(ids(layout, "left")).toEqual(["layers", "component"]);
		expect(ids(layout, "right")).toEqual(["m.forms.fields", "inspector", "entry"]);
		expect(placeOf(layout, "entry")?.panel.collapsed).toBe(true);
		expect(ids(layout, "bottom")).toEqual(["html", "css", "js"]);
		expect(layout.docks.right.share).toBe(0.25);
		// The stored layout itself is untouched.
		expect(ids(stored, "left")).toEqual(["layers"]);
		expect(withPanels(null, PANELS)).toEqual(defaults());
	});

	test("moving Layers to the left dock gives docking/02: Layers left, Inspector and a collapsed Entry right", () => {
		const moved = movePanel(defaults(), "layers", "left", "component");
		expect(ids(moved, "left")).toEqual(["layers", "component"]);
		expect(ids(moved, "right")).toEqual(["inspector", "entry"]);
		expect(placeOf(moved, "entry")?.panel.collapsed).toBe(true);
		expect(ids(moved, "bottom")).toEqual(["html", "css", "js"]);
		expect(storable(moved)).toBe(true);
	});

	test("a move lands before the panel named, or at the dock's end; within a dock too", () => {
		const layout = defaults();
		expect(ids(movePanel(layout, "css", "right", "inspector"), "right")).toEqual([
			"layers",
			"css",
			"inspector",
			"entry",
		]);
		expect(ids(movePanel(layout, "css", "right"), "right")).toEqual(["layers", "inspector", "entry", "css"]);
		expect(ids(movePanel(layout, "css", "right", "not-there"), "right")).toEqual([
			"layers",
			"inspector",
			"entry",
			"css",
		]);
		expect(ids(movePanel(layout, "entry", "right", "layers"), "right")).toEqual(["entry", "layers", "inspector"]);
		expect(ids(movePanel(layout, "html", "bottom"), "bottom")).toEqual(["css", "js", "html"]);
	});

	test("a move to where the panel already is changes nothing", () => {
		const layout = defaults();
		expect(movePanel(layout, "layers", "right", "inspector")).toBe(layout);
		expect(movePanel(layout, "entry", "right")).toBe(layout);
		expect(movePanel(layout, "layers", "right", "layers")).toBe(layout);
		expect(movePanel(layout, "nothing", "left")).toBe(layout);
	});

	test("after a move every panel of the two docks has an equal share; a third dock keeps its shares", () => {
		let layout = defaults();
		layout = resizePanels(
			layout,
			"right",
			[
				{ id: "layers", length: 400 },
				{ id: "inspector", length: 300 },
			],
			"layers",
			100,
		);
		layout = resizePanels(
			layout,
			"bottom",
			[
				{ id: "html", length: 300 },
				{ id: "css", length: 300 },
				{ id: "js", length: 300 },
			],
			"html",
			60,
		);
		const bottom = layout.docks.bottom.panels.map((panel) => panel.share);
		const moved = movePanel(layout, "inspector", "left");
		expect(moved.docks.right.panels.every((panel) => panel.share === undefined)).toBe(true);
		expect(moved.docks.left.panels.every((panel) => panel.share === undefined)).toBe(true);
		expect(moved.docks.bottom.panels.map((panel) => panel.share)).toEqual(bottom);
		expect(panelWeights(moved.docks.left.panels)).toEqual([0.5, 0.5]);
	});

	test("collapsing and switching off keep the panel's place, and change nothing else", () => {
		const layout = defaults();
		const collapsed = setCollapsed(layout, "layers", true);
		expect(placeOf(collapsed, "layers")).toEqual({ side: "right", index: 0, panel: { id: "layers", collapsed: true } });
		expect(setCollapsed(collapsed, "layers", false)).toEqual(layout);
		expect(setCollapsed(layout, "layers", false)).toBe(layout);

		const off = setHidden(layout, "css", true);
		expect(placeOf(off, "css")).toEqual({ side: "bottom", index: 1, panel: { id: "css", hidden: true } });
		expect(ids(off, "bottom")).toEqual(ids(layout, "bottom"));
		expect(ids(off, "right")).toEqual(ids(layout, "right"));
		expect(setHidden(off, "css", false)).toEqual(layout);
		expect(storable(off)).toBe(true);
	});

	test("a dock's size is kept as its share of the window, within its limits, so a smaller window keeps the shape", () => {
		let layout = resizeDock(defaults(), "right", 400, WINDOW);
		expect(layout.docks.right.share).toBeCloseTo(400 / 1440, 4);
		expect(dockLength(layout, "right", WINDOW)).toBe(400);
		// The same share of a smaller window.
		expect(dockLength(layout, "right", { width: 1280, height: 800 })).toBe(Math.round((400 / 1440) * 1280));

		layout = resizeDock(layout, "bottom", 450, WINDOW);
		expect(layout.docks.bottom.share).toBeCloseTo(0.5, 4);
		expect(dockLength(layout, "bottom", { width: 1440, height: 700 })).toBe(350);

		// The limits hold: side 200 to 500, bottom 40 to 700, whatever is asked and whatever the window.
		expect(dockLength(resizeDock(layout, "left", 900, WINDOW), "left", WINDOW)).toBe(DOCK_LIMITS.side.max);
		expect(dockLength(resizeDock(layout, "left", 20, WINDOW), "left", WINDOW)).toBe(DOCK_LIMITS.side.min);
		expect(dockLength(resizeDock(layout, "bottom", 900, WINDOW), "bottom", WINDOW)).toBe(DOCK_LIMITS.bottom.max);
		expect(dockLength(resizeDock(layout, "bottom", 0, WINDOW), "bottom", WINDOW)).toBe(DOCK_LIMITS.bottom.min);
		const wide = resizeDock(layout, "right", 500, WINDOW);
		expect(dockLength(wide, "right", { width: 4000, height: 2000 })).toBe(DOCK_LIMITS.side.max);
		expect(dockLength(wide, "right", { width: 400, height: 300 })).toBe(DOCK_LIMITS.side.min);
		expect(storable(wide)).toBe(true);
	});

	test("the docks together leave the canvas its 320 × 320 frame and gutters, never going under their minimum", () => {
		const roomy = fitDocks({ left: 314, right: 314, bottom: 266 }, WINDOW);
		expect(roomy).toEqual({ left: 314, right: 314, bottom: 266 });

		const tight = fitDocks({ left: 500, right: 400, bottom: 700 }, { width: 1024, height: 768 });
		const left = tight.left ?? 0;
		const right = tight.right ?? 0;
		expect(1024 - 48 - left - right).toBeGreaterThanOrEqual(CANVAS_MIN.width);
		expect(left).toBeGreaterThanOrEqual(DOCK_LIMITS.side.min);
		expect(right).toBeGreaterThanOrEqual(DOCK_LIMITS.side.min);
		// The wider dock gives up more.
		expect(500 - left).toBeGreaterThan(400 - right);
		expect(768 - 48 - (tight.bottom ?? 0)).toBeGreaterThanOrEqual(CANVAS_MIN.height);

		const closed = fitDocks({ left: null, right: 500, bottom: null }, { width: 1024, height: 768 });
		expect(closed).toEqual({ left: null, right: 500, bottom: null });
	});

	test("a separator between two panels shares their length; the other panels keep theirs; each keeps its minimum", () => {
		const lengths = [
			{ id: "html", length: 400 },
			{ id: "css", length: 400 },
			{ id: "js", length: 400 },
		];
		const layout = resizePanels(defaults(), "bottom", lengths, "html", 100);
		const weights = panelWeights(layout.docks.bottom.panels);
		expect(weights.map((weight) => Math.round(weight * 1200))).toEqual([500, 300, 400]);
		expect(storable(layout)).toBe(true);

		const squeezed = resizePanels(defaults(), "bottom", lengths, "html", -1000);
		expect(Math.round((panelWeights(squeezed.docks.bottom.panels)[0] ?? 0) * 1200)).toBe(PANEL_MIN.bottom);
		const side = resizePanels(
			defaults(),
			"right",
			[
				{ id: "layers", length: 300 },
				{ id: "inspector", length: 300 },
			],
			"layers",
			1000,
		);
		expect(Math.round((panelWeights(side.docks.right.panels.slice(0, 2))[1] ?? 0) * 600)).toBe(PANEL_MIN.side);
	});

	test("panels without a share of their own split what the others leave", () => {
		expect(panelWeights([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }])).toEqual([0.25, 0.25, 0.25, 0.25]);
		expect(panelWeights([{ id: "a", share: 0.5 }, { id: "b" }, { id: "c" }])).toEqual([0.5, 0.25, 0.25]);
		const weights = panelWeights([
			{ id: "a", share: 0.6 },
			{ id: "b", share: 0.6 },
		]);
		expect(weights).toEqual([0.5, 0.5]);
		expect(panelWeights([])).toEqual([]);
	});

	test("is stored with flags only where they are on, and null for the defaults", () => {
		const layout = setCollapsed(setHidden(defaults(), "css", true), "entry", false);
		const stored = storedLayout(layout);
		expect(stored?.docks.right.panels).toEqual([{ id: "layers" }, { id: "inspector" }, { id: "entry" }]);
		expect(stored?.docks.bottom.panels).toEqual([{ id: "html" }, { id: "css", hidden: true }, { id: "js" }]);
		expect(storedLayout(null)).toBeNull();
		// A whole layout is far under the 4096-byte cap.
		const busy = resizeDock(
			resizeDock(movePanel(defaults(), "layers", "left"), "left", 420, WINDOW),
			"bottom",
			300,
			WINDOW,
		);
		expect(JSON.stringify(storedLayout(busy)).length).toBeLessThan(600);
	});
});

describe("the panels' rules (SPEC 5)", () => {
	const nothing: PanelContext = { selection: null, document: "page", componentInPlace: false };
	const shown = (context: PanelContext) => PANELS.filter((panel) => panel.shows(context)).map((panel) => panel.id);

	test("on a page with nothing selected: Layers and Entry", () => {
		expect(shown(nothing)).toEqual(["layers", "entry"]);
	});

	test("an element selected: the Inspector and HTML, CSS and JS too", () => {
		expect(shown({ ...nothing, selection: { kind: "element", name: "h1 · Heading" } })).toEqual([
			"layers",
			"inspector",
			"entry",
			"html",
			"css",
			"js",
		]);
	});

	test("a Loop, a Condition or a Placement selected: HTML and JS, no CSS", () => {
		for (const kind of ["loop", "condition", "placement"] as const) {
			expect(shown({ ...nothing, selection: { kind, name: kind } })).toEqual([
				"layers",
				"inspector",
				"entry",
				"html",
				"js",
			]);
		}
	});

	test("with no document open (an address that opens nothing): Layers only", () => {
		expect(shown({ ...nothing, document: null })).toEqual(["layers"]);
	});

	test("a Template has no Entry panel; a Component edited in place brings the Component panel", () => {
		expect(shown({ ...nothing, document: "template" })).toEqual(["layers"]);
		expect(shown({ ...nothing, document: "entry", componentInPlace: true })).toEqual(["layers", "entry", "component"]);
	});
});

describe("the shell's start", () => {
	let install: TestInstall;
	let staff: TestBrowser;
	let siteId: string;
	let otherSiteId: string;

	beforeAll(async () => {
		install = await createTestInstall();
		const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
		staff = (await install.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).browser;
		siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
		otherSiteId = (await install.createSite(workspaceId, { name: "Acme Dairy", slug: "dairy" })).id;
	});

	afterAll(async () => {
		await install.close();
	});

	const layoutIn = async (site: string) => {
		const building = await openBuildingArea(install, staff, site);
		return shellConfigIn(await (await building.shell(building.landed)).text())?.layout;
	};

	test("is the defaults (none) until the person moves a panel, then their layout on every Site", async () => {
		expect(await layoutIn(siteId)).toBeNull();

		const moved = storedLayout(resizeDock(movePanel(defaults(), "layers", "left"), "right", 400, WINDOW));
		await staff.api.me.saveEditorPreferences({ siteId, preferences: { version: LAYOUT_VERSION, layout: moved } });
		expect(await layoutIn(siteId)).toEqual(moved);
		expect(await layoutIn(otherSiteId)).toEqual(moved);

		// Reset: none again.
		await staff.api.me.saveEditorPreferences({ siteId, preferences: { version: LAYOUT_VERSION, layout: null } });
		expect(await layoutIn(otherSiteId)).toBeNull();
	});
});
