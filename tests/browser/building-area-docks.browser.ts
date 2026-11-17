// The building area's docks and panels (ADR 0037, BA-05; SPEC 2, 4, 5 and 10; `docking/01` to `05`):
// - the defaults at 1440 × 900: the right dock 314 wide (Layers over the Inspector, Entry collapsed
//   under them), the bottom dock 266 high with HTML, CSS and JS, the left dock closed;
// - dragging a panel's grip to the left dock gives `docking/02`, with the drop box and the landing
//   line while it is in the air; the same by the header menu with the keyboard;
// - the layout is the person's: reloading, and another Site in another browser, show it; Reset
//   restores the defaults;
// - a panel switched off in the Panels menu goes even when its rule holds, and nothing else moves;
// - the docks' limits hold (side 200–500, bottom 40–700), kept as shares of the window;
// - a collapsed panel is its header only; double-clicking a separator collapses and restores;
// - Hide interface removes every dock; F6 goes through the open docks;
// - between 1024 and 1279 px the side docks open one at a time over the canvas;
// - the chrome with every dock open passes the accessibility checks, with the page in light and dark.
// The edit link may only be followed a few times a minute from one address: one page is shared.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Locator, Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { announced, enterBuildingArea, focusShellStart, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
let otherSiteId: string;
const slug = "bakery";
const otherSlug = "dairy";
const path = "/blog/fresh-bread";

/** A Site with a Site template, a Post Type with an Entry template, and one published post at `path`. */
async function makeSite(workspaceId: string, name: string, siteSlug: string): Promise<string> {
	const { api } = superadmin;
	const id = (await install.install.createSite(workspaceId, { name, slug: siteSlug })).id;
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId: id,
		markup: "<header><p>Welcome.</p></header><main>{{@outlet}}</main><footer><p>Harbour Street, Cork.</p></footer>",
	});
	await api.templates.publish({ siteId: id, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId: id,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId: id,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await api.templates.publish({ siteId: id, templateId: entry.template.id });
	const { entry: post } = await api.entries.create({
		siteId: id,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven" },
	});
	await api.entries.publish({ siteId: id, entryId: post.id });
	return id;
}

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.install.superadmin();
	const workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
	siteId = await makeSite(workspaceId, "Acme Bakery", slug);
	otherSiteId = await makeSite(workspaceId, "Acme Dairy", otherSlug);
	staff = (await install.install.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
});

let sharedPage: Promise<{ page: Page; frame: Frame }> | undefined;

/** The one page in the building area the checks share, at 1440 × 900. */
function shared() {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		const frame = await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
		await settled(page);
		return { page, frame };
	})();
	return sharedPage;
}

afterAll(async () => {
	await (
		await sharedPage
	)?.page
		.context()
		.close()
		.catch(() => {});
	await install?.close();
});

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(page: Page, selector: string): Promise<Box> {
	const box = await page.locator(selector).first().boundingBox();
	if (!box) throw new Error(`${selector} isn't shown.`);
	return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
}

/** Resizes the window and waits until the shell has drawn itself for the new size (the docks follow a moment later). */
async function resize(page: Page, width: number, height: number): Promise<void> {
	await page.setViewportSize({ width, height });
	await page.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [width, height]);
	let last = "";
	for (let attempt = 0; attempt < 20; attempt++) {
		await settled(page);
		const now = await page.evaluate(() =>
			[...document.querySelectorAll("[data-wc-dock], main#wc-canvas")]
				.map((element) => JSON.stringify(element.getBoundingClientRect()))
				.join(),
		);
		if (now === last) return;
		last = now;
		await page.waitForTimeout(50);
	}
}

/** The panels each dock shows, in order. */
async function docksOf(page: Page): Promise<Record<string, string[]>> {
	return page.evaluate(() => {
		const docks: Record<string, string[]> = {};
		for (const dock of document.querySelectorAll<HTMLElement>("[data-wc-dock]")) {
			docks[dock.dataset.wcDock ?? ""] = [...dock.querySelectorAll<HTMLElement>("[data-wc-panel]")].map(
				(panel) => panel.dataset.wcPanel ?? "",
			);
		}
		return docks;
	});
}

/** Selects the post's title in the page, as a click does. */
async function selectTitle(page: Page, frame: Frame): Promise<void> {
	const title = await frame.locator("h1").boundingBox();
	if (!title) throw new Error("No title.");
	await page.mouse.click(title.x + 5, title.y + title.height / 2);
	await page.locator('[data-wc-panel="inspector"]').waitFor();
	await settled(page);
}

/** Clears the selection: Escape in the page. */
async function clearSelection(page: Page, frame: Frame): Promise<void> {
	await frame.locator("h1").press("Escape");
	await page.locator('[data-wc-panel="inspector"]').waitFor({ state: "detached" });
}

/** Waits for the next write of the layout to the person's editor preferences, started by `act`. */
async function saved(page: Page, act: () => Promise<void>): Promise<void> {
	const written = page.waitForResponse((response) => response.url().includes("/me/saveEditorPreferences"));
	await act();
	expect((await written).status()).toBe(200);
}

/** Opens the Panels menu on the rail and chooses an entry: a panel's switch or the reset. */
async function panelsMenu(page: Page, choose: string): Promise<void> {
	await page.locator('[data-wc-rail="panels"]').click();
	const menu = page.getByRole("menu", { name: "Panels" });
	await menu.waitFor();
	await menu.getByRole(choose === "Reset panel layout" ? "menuitem" : "menuitemcheckbox", { name: choose }).click();
}

/** Resets the layout from the Panels menu, and waits for it to be written. */
async function resetLayout(page: Page): Promise<void> {
	await saved(page, async () => {
		await panelsMenu(page, "Reset panel layout");
	});
	await settled(page);
}

describe("the building area's docks and panels", () => {
	test("start with the defaults of SPEC 4 and 5 at 1440 × 900", async () => {
		const { page, frame } = await shared();
		// Nothing selected: Layers, and Entry collapsed under it; no Inspector, no code panes, no left dock.
		expect(await docksOf(page)).toEqual({ right: ["layers", "entry"] });
		expect(await boxOf(page, '[data-wc-dock="right"]')).toMatchObject({ x: 1440 - 314, width: 314, height: 852 });

		await selectTitle(page, frame);
		expect(await docksOf(page)).toEqual({ right: ["layers", "inspector", "entry"], bottom: ["html", "css", "js"] });
		expect((await boxOf(page, '[data-wc-dock="right"]')).width).toBe(314);
		const bottom = await boxOf(page, '[data-wc-dock="bottom"]');
		expect(bottom).toMatchObject({ x: 48, width: 1440 - 48 - 314, height: 266, y: 852 - 266 });
		// The canvas is what is left.
		expect(await boxOf(page, "main#wc-canvas")).toMatchObject({ x: 48, width: 1440 - 48 - 314, height: 852 - 266 });

		// Panels 298 wide in 8 of padding; headers 28 in a side dock, 36 below; Entry is its header only.
		expect((await boxOf(page, '[data-wc-panel="layers"]')).width).toBe(298);
		expect((await boxOf(page, '[data-wc-panel="layers"] [data-wc-panel-header]')).height).toBe(28);
		expect((await boxOf(page, '[data-wc-panel="entry"]')).height).toBe(28);
		expect((await boxOf(page, '[data-wc-panel="html"] [data-wc-panel-header]')).height).toBe(36);
		// The panes share the bottom dock's width equally.
		const widths = await Promise.all(
			["html", "css", "js"].map(async (id) => (await boxOf(page, `[data-wc-panel="${id}"]`)).width),
		);
		expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
		// The Inspector names what is selected.
		expect(await page.locator('[data-wc-panel="inspector"] h2').textContent()).toBe("Element");
		// Layers' header is the open document's name, which switches document (BA-06's switcher).
		const switcher = page.locator('[data-wc-panel="layers"] [data-wc-document-title]');
		expect(await switcher.textContent()).toContain("Fresh bread");
		await switcher.click();
		await page.getByRole("menu", { name: /^Switch document: / }).waitFor();
		await page.keyboard.press("Escape");
		await page.getByRole("menu", { name: /^Switch document: / }).waitFor({ state: "detached" });
		await clearSelection(page, frame);
	});

	test("dragging Layers' grip to the left dock gives docking/02; the drop box and the landing line show while it is in the air", async () => {
		const { page } = await shared();
		const grip = await boxOf(page, '[data-wc-grip="layers"]');
		await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await page.mouse.down();
		await page.mouse.move(grip.x - 200, grip.y + 120, { steps: 8 });
		await page.mouse.move(150, 300, { steps: 8 });
		await settled(page);

		// In the air: every dock is outlined, the empty left one is a drop box taking the accent colour,
		// with the line where the panel will land.
		expect(await page.locator('[data-wc-in-air="layers"]').count()).toBe(1);
		const dropBox = page.locator('[data-wc-drop-box="left"]');
		expect(await dropBox.textContent()).toBe("Left dock");
		expect(await page.locator('[data-wc-dock="left"]').getAttribute("data-target")).toBe("");
		expect(await dropBox.evaluate((box) => getComputedStyle(box).borderTopStyle)).toBe("dashed");
		expect(await page.locator('[data-wc-dock="right"]').evaluate((dock) => getComputedStyle(dock).outlineStyle)).toBe(
			"dashed",
		);
		const line = await boxOf(page, '[data-wc-landing-line="left"]');
		expect(line.height).toBe(2);
		expect((await boxOf(page, '[data-wc-dock="left"]')).width).toBe(314);

		await saved(page, async () => {
			await page.mouse.up();
		});
		expect(await docksOf(page)).toEqual({ left: ["layers"], right: ["entry"] });
		expect(await announced(page)).toBe("Layers moved to the left dock");
		expect((await boxOf(page, '[data-wc-dock="left"]')).width).toBe(314);
		expect(await page.locator("[data-wc-in-air]").count()).toBe(0);

		// With the title selected: docking/02, Layers left, the Inspector and a collapsed Entry right, the code panes below.
		const { frame } = await shared();
		await selectTitle(page, frame);
		expect(await docksOf(page)).toEqual({
			left: ["layers"],
			right: ["inspector", "entry"],
			bottom: ["html", "css", "js"],
		});
		const left = await boxOf(page, '[data-wc-dock="left"]');
		expect((await boxOf(page, '[data-wc-dock="bottom"]')).x).toBe(left.x + left.width);
		await clearSelection(page, frame);
		await resetLayout(page);
		expect(await docksOf(page)).toEqual({ right: ["layers", "entry"] });
	});

	test("a panel's header menu moves it with the keyboard, and focus follows it", async () => {
		const { page } = await shared();
		const menuButton = page.locator('[data-wc-panel-menu="layers"]');
		await menuButton.focus();
		await page.keyboard.press("Enter");
		const menu = page.getByRole("menu", { name: "Layers: panel menu" });
		await menu.waitFor();
		const items = await menu.getByRole("menuitem").allTextContents();
		expect(items).toEqual(["Move to left dock", "Move to bottom dock", "Collapse", "Hide panel", "Reset panel layout"]);
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Move to left dock");

		await saved(page, async () => {
			await page.keyboard.press("Enter");
		});
		expect(await docksOf(page)).toEqual({ left: ["layers"], right: ["entry"] });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-panel-menu"))).toBe("layers");
		expect(await announced(page)).toBe("Layers moved to the left dock");

		// Escape closes a menu and puts focus back on its button.
		await page.keyboard.press("Enter");
		await menu.waitFor();
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-panel-menu"))).toBe("layers");
	});

	test("the layout is the person's: a reload and another Site in another browser show it; Reset restores the defaults", async () => {
		const { page } = await shared();
		// Layers is on the left from the last check; the right dock is made wider with the keyboard.
		const edge = page.locator('[data-wc-dock-edge="right"]');
		await saved(page, async () => {
			await edge.focus();
			for (let press = 0; press < 3; press++) await page.keyboard.press("ArrowLeft");
		});
		expect((await boxOf(page, '[data-wc-dock="right"]')).width).toBe(344);
		expect(await edge.getAttribute("aria-valuenow")).toBe("344");

		await page.reload();
		await page.locator('[data-wc-dock="left"]').waitFor();
		expect(await docksOf(page)).toEqual({ left: ["layers"], right: ["entry"] });
		expect((await boxOf(page, '[data-wc-dock="right"]')).width).toBe(344);

		// Another browser, another Site, the same person.
		const other = await install.newPage("light");
		await other.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, other, { as: staff, siteId: otherSiteId, slug: otherSlug, open: `/page${path}` });
		await other.locator('[data-wc-dock="left"]').waitFor();
		expect(await docksOf(other)).toEqual({ left: ["layers"], right: ["entry"] });
		expect((await boxOf(other, '[data-wc-dock="right"]')).width).toBe(344);

		// Reset there is reset everywhere.
		await resetLayout(other);
		expect(await docksOf(other)).toEqual({ right: ["layers", "entry"] });
		expect((await boxOf(other, '[data-wc-dock="right"]')).width).toBe(314);
		await other.context().close();

		await page.reload();
		await page.locator('[data-wc-dock="right"]').waitFor();
		expect(await docksOf(page)).toEqual({ right: ["layers", "entry"] });
		expect((await boxOf(page, '[data-wc-dock="right"]')).width).toBe(314);
		sharedPage = Promise.resolve({ page, frame: await frameOf(page) });
	});

	test("a panel switched off in the Panels menu goes even when its rule holds; nothing else moves", async () => {
		const { page, frame } = await shared();
		await selectTitle(page, frame);
		const before = {
			right: await boxOf(page, '[data-wc-dock="right"]'),
			bottom: await boxOf(page, '[data-wc-dock="bottom"]'),
			layers: await boxOf(page, '[data-wc-panel="layers"]'),
			inspector: await boxOf(page, '[data-wc-panel="inspector"]'),
			html: await boxOf(page, '[data-wc-panel="html"]'),
		};

		await saved(page, async () => {
			await panelsMenu(page, "CSS");
		});
		const menu = page.getByRole("menu", { name: "Panels" });
		expect(await menu.getByRole("menuitemcheckbox", { name: "CSS" }).getAttribute("aria-checked")).toBe("false");
		expect(await menu.getByRole("menuitemcheckbox", { name: "Layers" }).getAttribute("aria-checked")).toBe("true");
		await page.keyboard.press("Escape");
		await settled(page);
		expect(await docksOf(page)).toEqual({ right: ["layers", "inspector", "entry"], bottom: ["html", "js"] });
		expect(await boxOf(page, '[data-wc-dock="right"]')).toEqual(before.right);
		expect(await boxOf(page, '[data-wc-dock="bottom"]')).toEqual(before.bottom);
		expect(await boxOf(page, '[data-wc-panel="layers"]')).toEqual(before.layers);
		expect(await boxOf(page, '[data-wc-panel="inspector"]')).toEqual(before.inspector);
		expect((await boxOf(page, '[data-wc-panel="html"]')).x).toBe(before.html.x);
		expect(await announced(page)).toBe("CSS switched off. The Panels menu switches it on again.");

		// On again: back where it was.
		await saved(page, async () => {
			await panelsMenu(page, "CSS");
		});
		await page.keyboard.press("Escape");
		expect(await docksOf(page)).toEqual({ right: ["layers", "inspector", "entry"], bottom: ["html", "css", "js"] });
		expect(await boxOf(page, '[data-wc-panel="html"]')).toEqual(before.html);
		await clearSelection(page, frame);
	});

	test("a collapsed panel is its header only; double-clicking a separator collapses the panel above and restores it", async () => {
		const { page, frame } = await shared();
		await selectTitle(page, frame);
		const between = page.locator('[data-wc-between="layers:inspector"]');
		const layers = await boxOf(page, '[data-wc-panel="layers"]');
		expect(layers.height).toBeGreaterThan(100);

		await between.dblclick();
		await settled(page);
		expect((await boxOf(page, '[data-wc-panel="layers"]')).height).toBe(28);
		expect(await page.locator('[data-wc-panel-body="layers"]').count()).toBe(0);
		expect(await page.locator('[data-wc-panel="layers"]').getAttribute("data-collapsed")).toBe("");

		await saved(page, async () => {
			await between.dblclick();
		});
		await settled(page);
		expect((await boxOf(page, '[data-wc-panel="layers"]')).height).toBe(layers.height);

		// A collapsed panel opens again from its Expand button.
		await page.locator('[data-wc-panel-expand="entry"]').click();
		await settled(page);
		expect((await boxOf(page, '[data-wc-panel="entry"]')).height).toBeGreaterThan(28);
		await page.locator('[data-wc-panel-menu="entry"]').click();
		await page.getByRole("menu", { name: "Entry: panel menu" }).getByRole("menuitem", { name: "Collapse" }).click();
		await settled(page);
		expect((await boxOf(page, '[data-wc-panel="entry"]')).height).toBe(28);

		// The arrow keys move a separator between two panels: the one above grows by 10 a press.
		const inspector = await boxOf(page, '[data-wc-panel="inspector"]');
		await between.focus();
		await page.keyboard.press("ArrowDown");
		await settled(page);
		// Within a pixel: shares are kept to four places.
		expect(Math.abs((await boxOf(page, '[data-wc-panel="layers"]')).height - (layers.height + 10))).toBeLessThanOrEqual(
			1,
		);
		expect(
			Math.abs((await boxOf(page, '[data-wc-panel="inspector"]')).height - (inspector.height - 10)),
		).toBeLessThanOrEqual(1);
		await clearSelection(page, frame);
		await resetLayout(page);
	});

	test("the docks' limits hold, and are kept as shares of the window", async () => {
		const { page, frame } = await shared();
		await selectTitle(page, frame);
		const drag = async (selector: string, dx: number, dy: number) => {
			const box = await boxOf(page, selector);
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.down();
			await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
			await page.mouse.up();
			await settled(page);
		};
		await drag('[data-wc-dock-edge="right"]', -600, 0);
		expect((await boxOf(page, '[data-wc-dock="right"]')).width).toBe(500);
		await drag('[data-wc-dock-edge="right"]', 600, 0);
		expect((await boxOf(page, '[data-wc-dock="right"]')).width).toBe(200);
		await drag('[data-wc-dock-edge="bottom"]', 0, 600);
		expect((await boxOf(page, '[data-wc-dock="bottom"]')).height).toBe(40);

		// Taller window: the bottom dock reaches its 700.
		await resize(page, 1440, 1300);
		await drag('[data-wc-dock-edge="bottom"]', 0, -900);
		expect((await boxOf(page, '[data-wc-dock="bottom"]')).height).toBe(700);

		// Kept as shares: 400 of 1440 is 356 of 1280.
		await resize(page, 1440, 900);
		await drag('[data-wc-dock-edge="right"]', -200, 0);
		expect((await boxOf(page, '[data-wc-dock="right"]')).width).toBe(400);
		await resize(page, 1280, 900);
		expect((await boxOf(page, '[data-wc-dock="right"]')).width).toBe(356);
		await resize(page, 1440, 900);
		await clearSelection(page, frame);
		await resetLayout(page);
	});

	test("Hide interface removes every dock and keeps the selection; F6 goes through the open docks", async () => {
		const { page, frame } = await shared();
		await selectTitle(page, frame);
		await focusShellStart(page);
		const region = () =>
			page.evaluate(
				() =>
					document.activeElement?.closest<HTMLElement>("[data-building-region]")?.dataset.buildingRegion ??
					(document.activeElement?.tagName === "IFRAME" ? "canvas" : null),
			);
		const visited: (string | null)[] = [];
		for (let press = 0; press < 5; press++) {
			await page.keyboard.press("F6");
			visited.push(await region());
		}
		expect(visited).toEqual(["rail", "right", "bottom", "canvas", "bar"]);

		await page.getByRole("button", { name: "Hide the interface" }).click();
		expect(await page.locator("[data-wc-dock]").count()).toBe(0);
		// The canvas runs from the rail to the window's edge; the selection still shows.
		expect(await boxOf(page, "main#wc-canvas")).toMatchObject({ x: 48, width: 1440 - 48, height: 852 });
		expect(await page.locator('[data-wc-outline="selected"]').isVisible()).toBe(true);
		await page.getByRole("button", { name: "Show the interface" }).click();
		expect(await docksOf(page)).toEqual({ right: ["layers", "inspector", "entry"], bottom: ["html", "css", "js"] });
		await clearSelection(page, frame);
	});

	test("between 1024 and 1279 px the side docks open one at a time over the canvas", async () => {
		const { page } = await shared();
		await resize(page, 1200, 800);
		expect(await page.locator('[data-wc-dock="right"]').count()).toBe(0);
		expect(await boxOf(page, "main#wc-canvas")).toMatchObject({ x: 48, width: 1200 - 48 });
		const toggle = page.locator('[data-wc-drawer-toggle="right"]');
		expect(await toggle.getAttribute("aria-label")).toBe("Show the right dock");

		await toggle.click();
		await page.locator('[data-wc-dock="right"]').waitFor();
		// Over the canvas: the canvas keeps its width.
		expect(await boxOf(page, "main#wc-canvas")).toMatchObject({ x: 48, width: 1200 - 48 });
		expect(await boxOf(page, '[data-wc-dock="right"]')).toMatchObject({ x: 1200 - 314, width: 314 });
		expect(
			await page.evaluate(() => document.activeElement?.closest("[data-wc-dock]")?.getAttribute("data-wc-dock")),
		).toBe("right");
		await page.keyboard.press("Escape");
		await page.locator('[data-wc-dock="right"]').waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-drawer-toggle"))).toBe("right");
		await resize(page, 1440, 900);
		expect(await docksOf(page)).toEqual({ right: ["layers", "entry"] });
	});

	test("with every dock open and a panel's menu ready, the chrome passes the accessibility checks in light and dark", async () => {
		const { page, frame } = await shared();
		await selectTitle(page, frame);
		await page.mouse.move(24, 460);
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			// The size readout the last keyboard walk showed (focus on a gutter) leaves 1.5 s later: until
			// then the next pass would count its controls as stops.
			await page.waitForTimeout(1800);
			await settled(page);
			await expectAccessibleScreen(page, `building area docks (${theme})`);
		}
		// The menus too.
		await page.locator('[data-wc-rail="panels"]').click();
		await page.getByRole("menu", { name: "Panels" }).waitFor();
		// Menus appear at once: no slide, no fade (SPEC 10).
		expect(await animationOf(page.getByRole("menu", { name: "Panels" }))).toBe("none");
		await expectNoAxeViolations(page, "building area docks, Panels menu");
		await page.keyboard.press("Escape");
		await page.locator('[data-wc-panel-menu="layers"]').click();
		await page.getByRole("menu", { name: "Layers: panel menu" }).waitFor();
		expect(await animationOf(page.getByRole("menu", { name: "Layers: panel menu" }))).toBe("none");
		await expectNoAxeViolations(page, "building area docks, a panel's menu");
		await page.keyboard.press("Escape");
	});
});

/**
 * The animation an element appears with. The browser asks for reduced motion, which only shortens
 * durations, so the name is what tells whether it slides or fades in.
 */
async function animationOf(element: Locator): Promise<string> {
	return element.evaluate((each) => getComputedStyle(each).animationName);
}
