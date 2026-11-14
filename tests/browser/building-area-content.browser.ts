// Places and the Content place in the building area (ADR 0037, BA-20; SPEC 2, 8 and 13.6), in Chromium:
// - the Content place opens from the rail over the canvas, keeping the rail and the bottom bar, and
//   each of the four ways back (its back button, the rail button again, Escape with no field focused,
//   the Command menu's event) leaves it, with the page and its selection as they were;
// - Enter in the create row makes a Draft Page and opens it on the canvas;
// - the status filter and the sorting change the address, so Back restores them;
// - reopening the place returns to the same list, scrolled where it was;
// - the Globals are a form whose values save to their Draft;
// - a Member sees their Content: Pages and the Post Types, "Site details", no Post Types section,
//   the tabs and "Write a new Entry…", and a back button that names the page;
// - the place passes the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
let blogId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	superadmin = await local.superadmin();
	const { api } = superadmin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;
	await api.languages.add({ siteId, code: "it" });

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const pagesType = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const pagesId = pagesType?.id ?? "";
	for (const [title, pageSlug, publish] of [
		["Home", "home", true],
		["Menu", "menu", true],
		["About", "about", false],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
		if (publish) await api.entries.publish({ siteId, entryId: entry.id });
		if (pageSlug === "home") await api.pages.setHomePage({ siteId, pageId: entry.id });
	}
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	blogId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: blogId,
		markup: "<article><h1>{{ title }}</h1><p>From the blog</p></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	// Enough posts for the list to scroll.
	for (let index = 1; index <= 40; index++) {
		const { entry: post } = await api.entries.create({ siteId, postTypeId: blogId, title: `Bake number ${index}` });
		if (index % 2) await api.entries.publish({ siteId, entryId: post.id });
	}
	await api.globals.setFields({
		siteId,
		fields: [
			{ key: "phone", label: "Phone", type: "text" },
			{
				key: "hours",
				label: "Opening hours",
				type: "group",
				fields: [{ key: "weekdays", label: "Weekdays", type: "text" }],
			},
		],
	});
});

afterAll(async () => {
	await install?.close();
});

/** The shell's address, after `/_webcraft/build`. */
function shellAddress(page: Page): string {
	const url = new URL(page.url());
	return `${url.pathname.slice("/_webcraft/build".length)}${url.search}`;
}

/** The shell's parameters in its address. */
function params(page: Page): URLSearchParams {
	return new URL(page.url()).searchParams;
}

/** Opens a shell address in the page (as a bookmark or a typed address does). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
}

const placeFrame = (page: Page) => page.locator("[data-wc-place-frame]");
const railButton = (page: Page) => page.locator('[data-wc-place="content"]');
/** The page in its frame, which stays underneath a place, hidden. */
const canvas = (page: Page) => page.locator("iframe[data-wc-frame]");

/** Opens the Content place from the rail, and waits for its list. */
async function openContent(page: Page): Promise<void> {
	await railButton(page).click();
	await placeFrame(page).waitFor();
	await page.locator("[data-wc-content-lists]").waitFor();
}

/** Waits until the place is gone and the canvas is back. */
async function placeLeft(page: Page): Promise<void> {
	await placeFrame(page).waitFor({ state: "detached" });
	await canvas(page).waitFor({ state: "visible", timeout: 5_000 });
	expect(params(page).get("wc-place")).toBeNull();
}

/** The titles the open list shows, in its order. */
async function titles(page: Page): Promise<string[]> {
	return page.locator("[data-wc-entry-title]").allTextContents();
}

describe("the Content place, for Staff", () => {
	let page: Page;
	let frame: Frame;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		frame = await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("opens over the canvas, keeps the rail and the bar, and each way back returns to the page as it was", async () => {
		// Something selected on the page first.
		await frame.locator("main").scrollIntoViewIfNeeded();
		const box = await frame.locator("header p").boundingBox();
		if (!box) throw new Error("The page shows no header.");
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await page.locator('[data-wc-outline="selected"]').waitFor();
		const selected = await page.locator('[data-wc-outline="selected"]').boundingBox();

		await openContent(page);
		expect(params(page).get("wc-place")).toBe("content/pages");
		expect(await announced(page)).toBe("Content opened");
		// The place takes the canvas's room; the rail and the bar stay, with no insert row and no Panels.
		expect(await canvas(page).isVisible()).toBe(false);
		expect(await page.locator("[data-wc-under-place]").getAttribute("inert")).not.toBeNull();
		// Inside the shell's main part, which the skip link and F6 reach.
		expect(await page.locator("main [data-wc-place-frame]").count()).toBe(1);
		expect(await page.locator("[data-building-region='rail']").isVisible()).toBe(true);
		expect(await page.locator("[data-building-region='bar']").isVisible()).toBe(true);
		expect(await page.locator("[data-wc-insert-row]").count()).toBe(0);
		expect(await page.locator('[data-wc-rail="panels"]').count()).toBe(0);
		expect(await railButton(page).getAttribute("aria-pressed")).toBe("true");
		// Sizes of SPEC 4: the inner sidebar 256, the back button 40 × 28, rows 46 and the header 35.
		expect((await page.locator("[data-wc-place-sidebar]").boundingBox())?.width).toBe(256);
		expect(await page.locator("[data-wc-place-back]").boundingBox()).toMatchObject({ width: 40, height: 28 });
		expect((await page.locator("[data-wc-place-header]").boundingBox())?.height).toBe(40);
		expect((await page.locator("[data-wc-entry]").first().boundingBox())?.height).toBe(46);
		expect((await page.locator("[data-wc-grid] thead tr").boundingBox())?.height).toBe(35);
		expect((await page.locator("[data-wc-create-row]").boundingBox())?.height).toBe(50);
		// Focus starts on the back button.
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-place-back"))).toBe(true);

		// 1. The back button: the page and its selection as they were; focus back on the rail button.
		await page.locator("[data-wc-place-back]").click();
		await placeLeft(page);
		await settled(page);
		expect(await page.locator('[data-wc-outline="selected"]').boundingBox()).toEqual(selected);
		expect(new URL(frame.url()).pathname).toBe("/menu");

		// 2. The rail button again.
		await openContent(page);
		await railButton(page).click();
		await placeLeft(page);
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-place"))).toBe("content");

		// 3. Escape, but not while a field has focus.
		await openContent(page);
		await page.locator("[data-wc-content-search]").focus();
		await page.keyboard.press("Escape");
		expect(await placeFrame(page).count()).toBe(1);
		await page.locator("[data-wc-place-back]").focus();
		await page.keyboard.press("Escape");
		await placeLeft(page);

		// 4. The Command menu's way (the event it sends), in and out.
		await page.evaluate(() =>
			document.dispatchEvent(new CustomEvent("webcraft:place", { detail: { place: "content" } })),
		);
		await placeFrame(page).waitFor();
		await page.evaluate(() => document.dispatchEvent(new CustomEvent("webcraft:place", { detail: { place: null } })));
		await placeLeft(page);
		await settled(page);
		expect(await page.locator('[data-wc-outline="selected"]').boundingBox()).toEqual(selected);
	});

	test("the sidebar lists Pages and each Post Type with counts, the Globals and Post Types; the grid its columns", async () => {
		await go(page, "/page/menu?wc-place=content%2Fpages");
		await page.locator("[data-wc-content-lists]").waitFor();

		const rows = page.locator("[data-wc-content-row]");
		expect(await rows.allTextContents()).toEqual(["Pages3", "Blog posts40", "Globals"]);
		expect(await page.locator('[data-wc-content-row="pages"]').getAttribute("aria-current")).toBe("page");
		expect(await page.locator("[data-wc-place-sidebar]").textContent()).toContain("Post TypesStaff");
		expect(await page.locator("[data-wc-entries-summary]").textContent()).toBe("3 Entries · EN, IT");
		expect(await page.locator("[data-wc-grid] thead th").allTextContents()).toEqual([
			"Title",
			"Address",
			"Status",
			"Languages",
			"Author",
			"Updated",
			"Actions",
		]);
		// Pages by address: the home page first. A Draft shows its Draft's address.
		expect(await titles(page)).toEqual(["Home", "About", "Menu"]);
		expect(await page.locator("[data-wc-entry-address]").allTextContents()).toEqual(["/", "/about", "/menu"]);
		expect(await page.locator("[data-wc-entry]").nth(1).textContent()).toContain("Draft");
	});

	test("Enter in the create row makes a Draft Page and opens it on the canvas", async () => {
		await go(page, "/page/menu?wc-place=content%2Fpages");
		const title = page.locator("[data-wc-create-title]");
		await title.fill("Order a cake");
		expect(await page.locator("[data-wc-create-row]").textContent()).toContain("/order-a-cake");

		await title.press("Enter");

		await page.waitForURL((url) => url.pathname === "/_webcraft/build/page/order-a-cake", { timeout: 10_000 });
		await placeFrame(page).waitFor({ state: "detached" });
		const opened = await frameOf(page);
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.contentWindow?.location.pathname ===
				"/order-a-cake",
		);
		expect(new URL(opened.url()).pathname).toBe("/order-a-cake");
		const pagesType = (await superadmin.api.postTypes.list({ siteId })).postTypes.find(
			(type) => type.builtIn === "page",
		);
		const { entries } = await superadmin.api.entries.list({ siteId, postTypeId: pagesType?.id ?? "" });
		expect(entries.find((each) => each.draft.title === "Order a cake")?.status).toBe("draft");
	});

	test("the status filter and the sorting change the address, and Back restores them", async () => {
		await go(page, `/page/menu?wc-place=content%2F${blogId}`);
		await page.locator(`[data-wc-entries="${blogId}"]`).waitFor();
		expect((await titles(page)).length).toBe(40);

		await page.locator('[data-wc-filter="status"]').click();
		await page.locator('[data-wc-choice="draft"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "status=draft");
		expect((await titles(page)).length).toBe(20);
		expect(await page.locator('[data-wc-filter="status"]').textContent()).toBe("Status: Drafts");

		await page.locator("[data-wc-sort]").click();
		await page.locator('[data-wc-choice="title"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "status=draft&sort=title");
		expect((await titles(page)).slice(0, 3)).toEqual(["Bake number 2", "Bake number 4", "Bake number 6"]);

		await page.goBack();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "status=draft");
		// Back to the default order (newest first), the filter kept.
		await page.locator('[data-wc-sort="-updated"]').waitFor();
		expect((await titles(page)).length).toBe(20);
		await page.goBack();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === null);
		expect((await titles(page)).length).toBe(40);
		expect(params(page).get("wc-place")).toBe(`content/${blogId}`);

		// Typing a search changes the address in place: no history entry for each key.
		const before = await page.evaluate(() => history.length);
		await page.locator("[data-wc-content-search]").fill("number 1");
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "q=number+1");
		expect(await page.evaluate(() => history.length)).toBe(before);
		expect(await titles(page)).toContain("Bake number 12");
		expect(await titles(page)).not.toContain("Bake number 2");
	});

	test("reopening the place returns to the same list, scrolled where it was", async () => {
		await go(page, "/page/menu");
		await frameOf(page);
		await openContent(page);
		await page.locator(`[data-wc-content-row="${blogId}"]`).click();
		await page.locator(`[data-wc-entries="${blogId}"]`).waitFor();
		const scroller = page.locator("[data-wc-place-scroll]");
		await scroller.evaluate((element) => {
			element.scrollTop = 600;
			element.dispatchEvent(new Event("scroll"));
		});
		const at = await scroller.evaluate((element) => element.scrollTop);
		expect(at).toBeGreaterThan(300);

		await page.locator("[data-wc-place-back]").click();
		await placeLeft(page);
		await openContent(page);

		expect(params(page).get("wc-place")).toBe(`content/${blogId}`);
		await page.locator(`[data-wc-entries="${blogId}"]`).waitFor();
		await settled(page);
		expect(await scroller.evaluate((element) => element.scrollTop)).toBe(at);
	});

	test("the Globals are a form: a value typed is saved to their Draft", async () => {
		await go(page, "/page/menu?wc-place=content%2Fpages");
		await page.locator('[data-wc-content-row="globals"]').click();
		await page.locator("[data-wc-globals]").waitFor();
		expect(await page.locator("[data-wc-global-group='hours'] legend").textContent()).toBe("Opening hours");

		await page.getByLabel("Phone").fill("+353 21 000 0000");
		await page.getByLabel("Weekdays").fill("8–18");
		await page.getByLabel("Weekdays").blur();

		await page.locator('[data-wc-draft-state="saved"]').waitFor();
		for (let attempt = 0; attempt < 40; attempt++) {
			const { draft } = (await superadmin.api.globals.get({ siteId })).globals;
			if (draft.phone === "+353 21 000 0000" && (draft.hours as { weekdays?: string })?.weekdays === "8–18") break;
			await page.waitForTimeout(100);
		}
		expect((await superadmin.api.globals.get({ siteId })).globals.draft).toMatchObject({
			phone: "+353 21 000 0000",
			hours: { weekdays: "8–18" },
		});
	});

	for (const theme of THEMES) {
		test(`the place passes the accessibility checks, with the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, "/page/menu?wc-place=content%2Fpages");
			await page.locator("[data-wc-entry]").first().waitFor();
			await expectAccessibleScreen(page, `building area, Content place (${theme})`);
		});
	}
});

describe("the Content place, for a Member", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("shows their Content: Pages and the Post Types, Site details, no Post Types section", async () => {
		await page.waitForFunction(() => document.querySelector("iframe[data-wc-frame]") !== null);
		await openContent(page);

		expect(await page.locator("[data-wc-place-back]").textContent()).toBe("Back to Menu");
		// Every Post Type (there is no narrower set for a Member), then the Globals by their Groups.
		expect(await page.locator("[data-wc-content-row]").allTextContents()).toEqual([
			expect.stringMatching(/^Pages\d+$/),
			"Blog posts40",
			"All details",
			"Opening hours",
		]);
		expect(await page.locator("[data-wc-place-sidebar]").textContent()).toContain("Site details");
		expect(await page.locator("[data-wc-place-sidebar]").textContent()).not.toContain("Post Types");
		expect(await page.locator("[data-wc-new-post-type]").count()).toBe(0);
		expect(await page.locator("[data-wc-tab]").allTextContents()).toEqual([
			expect.stringMatching(/^All\d+$/),
			expect.stringMatching(/^Published\d+$/),
			expect.stringMatching(/^Drafts\d+$/),
			"In review0",
		]);
		expect(await page.locator("[data-wc-create-title]").getAttribute("placeholder")).toBe("Write a new Page…");
	});

	test("Write a new Entry… makes a Draft and opens it on the canvas; Back to the page returns", async () => {
		await go(page, `/page/menu?wc-place=content%2F${blogId}`);
		await page.locator(`[data-wc-entries="${blogId}"]`).waitFor();
		await page.locator('[data-wc-tab="draft"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "status=draft");
		expect((await titles(page)).length).toBe(20);

		await page.locator("[data-wc-create-title]").fill("Spring menu, tasted early");
		await page.locator("[data-wc-create-title]").press("Enter");

		await page.waitForURL((url) => url.pathname === "/_webcraft/build/page/blog/spring-menu-tasted-early", {
			timeout: 10_000,
		});
		expect(shellAddress(page)).toBe("/page/blog/spring-menu-tasted-early");
	});

	for (const theme of THEMES) {
		test(`a Member's place passes the accessibility checks, with the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, `/page/menu?wc-place=content%2F${blogId}`);
			await page.locator("[data-wc-entry]").first().waitFor();
			await expectAccessibleScreen(page, `building area, a Member's Content place (${theme})`);
		});
	}
});
