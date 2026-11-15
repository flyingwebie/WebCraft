// List items and query Loops in client editing (ADR 0037, BA-16; SPEC 13.3, `client/05`), for a Member,
// in Chromium:
// - a Loop's own items are marked; a click (or Enter once one has focus) selects one: a solid outline, a
//   bar on its top edge (its name, move earlier, move later, duplicate, remove; Alt+F10 reaches it) and
//   the side panel with all its Fields ("Our bakes · item 2 of 3", previous and next, Remove this item,
//   Done); its values aren't typed in place;
// - each Field saves to the Loop's Draft and the page shows it; moves are announced; a removed item
//   comes back where it was with Undo; Duplicate and "Add an item" (a dashed card at the end of the list)
//   make new items;
// - a query Loop's item shows a chip that says where it comes from and opens the Entry's own page;
// - Tab goes through items and the "Add" card in the page's order; Preview takes every mark away;
// - the shell passes axe and the keyboard check, light and dark.
// Every `loop/*` edit request of `tests/edit-mode/loop-items.test.ts` is reached from here. The building
// area's own test of the old editing bar's Loop item tools (`edit-mode-in-place.browser.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { enterBuildingArea, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let api: TestBrowser["api"];
let editor: TestAccount;
let siteId: string;
let loopId: string;
let rolls: string;
const slug = "bakery";
const path = "/recipes/menu";

/** The Loop's items as the test starts each part: names, prices, a photo on the first. */
let loaf: string;
const BAKES = () => [
	{ name: "Country sourdough", price: "€6.50", photo: loaf, soldOut: false },
	{ name: "Cardamom bun", price: "€3.20", photo: null, soldOut: false },
	{ name: "Seeded rye", price: "€5.90", photo: null, soldOut: false },
];

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	({ api } = await local.superadmin());
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;
	const image = async (name: string, wider: number) => {
		const { media } = await api.media.upload({
			siteId,
			file: upload(await photo({ width: 400 + wider, height: 300 }), name),
		});
		return media.id;
	};
	loaf = await image("loaf.jpg", 0);
	rolls = await image("rolls.jpg", 20);
	await local.drainJobs();

	const { loop } = await api.loops.create({
		siteId,
		name: "our-bakes",
		source: "items",
		fields: [
			{ key: "name", label: "Name", type: "text", required: true },
			{ key: "price", label: "Price", type: "text" },
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "description", label: "Description", type: "richText" },
			{ key: "soldOut", label: "Sold out today", type: "boolean" },
		],
	});
	loopId = loop.id;
	await api.loops.saveItems({ siteId, loopId, items: BAKES() });
	await api.loops.publish({ siteId, loopId });

	const { postType: blog } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "blog",
		urlPattern: "/blog/{slug}",
		fields: [],
	});
	const blogTemplate = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: blog.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await api.templates.publish({ siteId, templateId: blogTemplate.template.id });
	for (const title of ["Our sourdough starter, explained", "Spring menu"]) {
		await local.clock.advance(1000);
		const { entry } = await api.entries.create({ siteId, postTypeId: blog.id, title });
		await api.entries.publish({ siteId, entryId: entry.id });
	}
	const { loop: latest } = await api.loops.create({
		siteId,
		name: "latest-posts",
		source: "query",
		query: { postTypes: ["blog"] },
	});
	await api.loops.publish({ siteId, loopId: latest.id });

	const { postType: recipes } = await api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: recipes.id,
		markup: [
			"<article><h1>{{ title }}</h1>",
			'<ul>{{@loop our-bakes as bake}}<li><h2>{{ bake.name }}</h2><p>{{ bake.price }}</p><img src="{{ bake.photo }}" width="160" height="120"></li>{{/loop}}</ul>',
			"<h2>From the blog</h2>",
			"{{@loop latest-posts as post}}<section><h3>{{ post.title }}</h3></section>{{/loop}}",
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry: menu } = await api.entries.create({ siteId, postTypeId: recipes.id, title: "Menu" });
	await api.entries.publish({ siteId, entryId: menu.id });
});

afterAll(async () => {
	await install?.close();
});

type Box = { x: number; y: number; width: number; height: number };

async function boxIn(frame: Frame, selector: string, nth = 0): Promise<Box> {
	const found = await frame.locator(selector).nth(nth).boundingBox();
	if (!found) throw new Error(`${selector} isn't shown in the page.`);
	return found;
}

/** Waits until the shell has said `text`. */
async function said(page: Page, text: string, timeout = 8000): Promise<void> {
	await page.waitForFunction(
		(text) => (document.querySelector("[data-wc-messages]")?.textContent ?? "").replaceAll(" ", "").includes(text),
		text,
		{ timeout },
	);
}

/** Waits until a value read over the API is what `ok` wants; answers the last one read. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, tries = 60): Promise<T> {
	let last = await read();
	for (let attempt = 0; attempt < tries && !ok(last); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		last = await read();
	}
	return last;
}

/** The Loop's Draft items, as Staff read them in the admin. */
async function draftItems() {
	return (await api.loops.get({ siteId, loopId })).loop.draft.items;
}
const names = async () => (await draftItems()).map((item) => item.name);

/** The items' names as the page in the frame shows them. */
async function shownNames(frame: Frame): Promise<string[]> {
	return frame.locator("li h2").allTextContents();
}

/** Waits until the page in the frame shows these names, in this order. */
async function untilShown(frame: Frame, wanted: string[]): Promise<void> {
	await frame.waitForFunction(
		(wanted) => JSON.stringify([...document.querySelectorAll("li h2")].map((each) => each.textContent)) === wanted,
		JSON.stringify(wanted),
	);
}

/** Waits until the frame shows `pathname`, its regions there. */
async function framedAt(page: Page, pathname: string): Promise<Frame> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = await page.locator("iframe[data-wc-frame]").elementHandle();
		const frame = await handle?.contentFrame();
		if (frame && new URL(frame.url()).pathname === pathname) {
			await frame.waitForLoadState("load");
			await frame.locator("h1[contenteditable]").waitFor();
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${pathname}.`);
}

/** The element focus is on in the page in the frame: its tag and its text's start. */
async function focusInPage(frame: Frame): Promise<string | null> {
	return frame.evaluate(() => {
		const element = document.activeElement;
		if (!element || element === document.body) return null;
		return `${element.localName}:${(element.textContent ?? "").trim().slice(0, 18)}`;
	});
}

const panel = "[data-wc-item-panel]";
const bar = "[data-wc-item-bar]";

describe("a Loop's own items, for an Editor", () => {
	let page: Page;
	let frame: Frame;

	/** The Loop as it was, and the page read again, before each part (one that failed leaves nothing behind). */
	const reset = async () => {
		await api.loops.saveItems({ siteId, loopId, items: BAKES() });
		await page.reload();
		frame = await framedAt(page, path);
		await page.locator("[data-wc-loop-add-card]").waitFor();
	};

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		frame = await enterBuildingArea(install, page, { as: editor, siteId, slug, open: `/page${path}` });
		await frame.locator("h1[contenteditable]").waitFor();
		await page.locator("[data-wc-loop-add-card]").waitFor();
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("items are marked at rest; a click selects one: its bar, and its Fields in the side panel", async () => {
		// Each item is outlined at rest, with "Add an item" as a dashed card at the end of the list.
		expect(await page.locator('[data-wc-item-mark="rest"]').count()).toBe(3);
		expect(await page.locator("[data-wc-loop-add-card]").textContent()).toBe("Add an item");
		expect(await frame.locator("[data-wc-loop-add] button").getAttribute("aria-label")).toBe(
			"Add an item to Our bakes",
		);
		// An item's values are changed in its panel, not typed in place; they aren't marked one by one.
		expect(await frame.locator("li h2").first().getAttribute("contenteditable")).toBe("false");
		expect(await page.locator('[data-wc-client-mark="rest"]').count()).toBe(1);

		const second = await boxIn(frame, "li", 1);
		await page.mouse.move(second.x + 40, second.y + 10);
		await page.locator("[data-wc-item-chip]", { hasText: "Cardamom bunClick to edit" }).waitFor();
		await page.locator('[data-wc-item-mark="hover"]').waitFor();

		await page.mouse.click(second.x + 40, second.y + 10);
		await page.locator(bar).waitFor();
		expect(await page.locator(`${bar} [data-wc-item-bar-name]`).textContent()).toBe("Cardamom bun");
		expect(await page.getByRole("toolbar", { name: "Tools for Cardamom bun" }).count()).toBe(1);
		// Selected: a solid outline and no chip (the bar names it); the bar sits on its top edge.
		await page.locator('[data-wc-item-mark="selected"]').waitFor();
		expect(await page.locator("[data-wc-item-chip]").count()).toBe(0);
		const outline = await page.locator('[data-wc-item-mark="selected"]').boundingBox();
		const drawn = await page.locator(bar).boundingBox();
		expect(outline && drawn).toBeTruthy();
		if (outline && drawn) {
			expect(Math.abs(drawn.y + drawn.height / 2 - outline.y)).toBeLessThanOrEqual(2);
			expect(drawn.height).toBe(32);
		}

		// The side panel: the item's name, where it is, every Field; focus on its heading.
		const side = page.locator(panel);
		await side.waitFor();
		expect(await side.locator("[data-wc-item-panel-name]").textContent()).toBe("Cardamom bun");
		expect(await side.locator("[data-wc-item-panel-position]").textContent()).toBe("Our bakes · item 2 of 3");
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Cardamom bun");
		await side.getByLabel("Name").waitFor();
		expect(await side.getByLabel("Name").inputValue()).toBe("Cardamom bun");
		expect(await side.getByLabel("Price").inputValue()).toBe("€3.20");
		expect(await side.getByRole("switch", { name: "Sold out today" }).getAttribute("aria-checked")).toBe("false");
		await side.locator('[data-wc-item-field="photo"]').waitFor();
		await side.getByRole("textbox", { name: "Description" }).waitFor();
		// 360 wide on the right; it pushes the page.
		const sideBox = await side.boundingBox();
		expect(sideBox?.width).toBe(360);
		expect(sideBox ? sideBox.x + sideBox.width : 0).toBe(1440);

		// Previous and next items, in the panel; the last item has no next.
		await side.getByRole("button", { name: "Next item" }).click();
		await side.locator("[data-wc-item-panel-position]", { hasText: "Our bakes · item 3 of 3" }).waitFor();
		await side.locator("[data-wc-item-panel-name]", { hasText: "Seeded rye" }).waitFor();
		expect(await side.getByRole("button", { name: "Next item" }).getAttribute("aria-disabled")).toBe("true");
		expect(await page.locator(`${bar} [data-wc-item-bar-name]`).textContent()).toBe("Seeded rye");
		await side.getByRole("button", { name: "Previous item" }).click();
		await side.locator("[data-wc-item-panel-name]", { hasText: "Cardamom bun" }).waitFor();

		// Done puts the panel away; focus back on the item in the page.
		await side.getByRole("button", { name: "Done" }).click();
		await side.waitFor({ state: "detached" });
		await page.locator(bar).waitFor({ state: "detached" });
		expect(await focusInPage(frame)).toBe("li:Cardamom bun€3.20");
	});

	test("each Field saves to the Loop's Draft, and the page shows it", async () => {
		await reset();
		const second = await boxIn(frame, "li", 1);
		await page.mouse.click(second.x + 40, second.y + 10);
		const side = page.locator(panel);
		await side.getByLabel("Price").waitFor();

		await side.getByLabel("Price").fill("€3.50");
		expect(await eventually(draftItems, (items) => items[1]?.price === "€3.50")).toMatchObject([
			{ name: "Country sourdough" },
			{ name: "Cardamom bun", price: "€3.50" },
			{ name: "Seeded rye" },
		]);
		await frame.locator("li p", { hasText: "€3.50" }).waitFor();
		// The bar says what is left to publish (the Loop's items wait for Staff).
		await page.locator('[data-wc-draft-state="changes"]').waitFor({ timeout: 6000 });

		await side.getByRole("switch", { name: "Sold out today" }).click();
		expect(await eventually(draftItems, (items) => items[1]?.soldOut === true)).toMatchObject([
			{},
			{ soldOut: true },
			{},
		]);

		// The name in the panel's header follows the Name as it is typed.
		await side.getByLabel("Name").fill("Cardamom knot");
		await side.locator("[data-wc-item-panel-name]", { hasText: "Cardamom knot" }).waitFor();
		await untilShown(frame, ["Country sourdough", "Cardamom knot", "Seeded rye"]);
		expect(await names()).toEqual(["Country sourdough", "Cardamom knot", "Seeded rye"]);

		// A photo from the Media library.
		await side.locator('[data-wc-item-field="photo"]').click();
		const picker = page.locator("[data-wc-media-picker]");
		await picker.waitFor();
		await picker.locator(`[data-wc-pick="${rolls}"]`).click();
		await picker.locator("[data-wc-pick-select]").click();
		expect(await eventually(draftItems, (items) => items[1]?.photo === rolls)).toMatchObject([
			{},
			{ photo: rolls },
			{},
		]);
		await frame.locator(`li img[data-wc-media="${rolls}"]`).waitFor();
		await side.locator("[data-wc-item-thumbnail]").waitFor();

		// A required value emptied: its problem shows under it.
		await side.getByLabel("Name").fill("");
		await side.locator('[data-wc-item-problem="name"]', { hasText: "This can't be empty." }).waitFor();
		expect(await side.getByLabel("Name").getAttribute("aria-invalid")).toBe("true");
		await side.getByLabel("Name").fill("Cardamom bun");
		await side.locator('[data-wc-item-problem="name"]').waitFor({ state: "detached" });
		await untilShown(frame, ["Country sourdough", "Cardamom bun", "Seeded rye"]);

		await page.keyboard.press("Escape");
		await side.waitFor({ state: "detached" });
		expect(await focusInPage(frame)).toMatch(/^li:Cardamom bun/);
	});

	test("Alt+F10 reaches the item bar; a move is announced and saved; Escape goes back to the item", async () => {
		await reset();
		await frame.locator("li").first().focus();
		await said(page, "Country sourdough, item 1 of 3 in Our bakes. Press Enter to change it, Alt+F10 for its tools.");
		await page.locator("[data-wc-item-chip]", { hasText: "Country sourdoughPress Enter to edit" }).waitFor();

		await page.keyboard.press("Alt+F10");
		const toolbar = page.getByRole("toolbar", { name: "Tools for Country sourdough" });
		await toolbar.waitFor();
		// Move earlier is off for the first item: focus is on Move later.
		expect(await toolbar.getByRole("button", { name: "Move earlier" }).getAttribute("aria-disabled")).toBe("true");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Move later");
		// No panel opens: only the bar.
		expect(await page.locator(panel).count()).toBe(0);

		await page.keyboard.press("Enter");
		await said(page, "Moved to place 2 of 3");
		expect(await eventually(names, (list) => list[0] !== "Country sourdough")).toEqual([
			"Cardamom bun",
			"Country sourdough",
			"Seeded rye",
		]);
		await untilShown(frame, ["Cardamom bun", "Country sourdough", "Seeded rye"]);
		// The item stays selected with its bar, focus still in it; the arrows move between its tools.
		await page.keyboard.press("Enter");
		await said(page, "Moved to place 3 of 3");
		await untilShown(frame, ["Cardamom bun", "Seeded rye", "Country sourdough"]);
		// At the end Move later is off; focus stays on it, in the bar.
		expect(await toolbar.getByRole("button", { name: "Move later" }).getAttribute("aria-disabled")).toBe("true");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Move later");
		await page.keyboard.press("ArrowLeft");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Move earlier");
		await page.keyboard.press("Enter");
		await said(page, "Moved to place 2 of 3");
		await untilShown(frame, ["Cardamom bun", "Country sourdough", "Seeded rye"]);

		await page.keyboard.press("Escape");
		expect(await focusInPage(frame)).toBe("li:Country sourdough€");
		// Escape in the page puts the bar away, the item keeping focus.
		await page.keyboard.press("Escape");
		await page.locator(bar).waitFor({ state: "detached" });
		expect(await focusInPage(frame)).toBe("li:Country sourdough€");
		// Enter on an item with focus opens its panel.
		await page.keyboard.press("Enter");
		await page.locator(panel).locator("[data-wc-item-panel-name]", { hasText: "Country sourdough" }).waitFor();
		await page.keyboard.press("Escape");
		await page.locator(panel).waitFor({ state: "detached" });
	});

	test("Remove, then Undo puts the item back where it was", async () => {
		await reset();
		const second = await boxIn(frame, "li", 1);
		await page.mouse.click(second.x + 40, second.y + 10);
		await page.locator(bar).getByRole("button", { name: "Remove" }).click();

		expect(await eventually(names, (list) => list.length === 2)).toEqual(["Country sourdough", "Seeded rye"]);
		await untilShown(frame, ["Country sourdough", "Seeded rye"]);
		const toast = page.locator("[data-wc-item-toast]");
		await toast.getByText("Cardamom bun removed").waitFor();
		await said(page, "Cardamom bun removed. Undo is at the top of the window for 8 seconds.");
		// The panel went with its item; focus is on the item that took its place.
		expect(await page.locator(panel).count()).toBe(0);
		expect(await focusInPage(frame)).toMatch(/^li:Seeded rye/);

		await toast.getByRole("button", { name: "Put Cardamom bun back" }).click();
		expect(await eventually(names, (list) => list.length === 3)).toEqual([
			"Country sourdough",
			"Cardamom bun",
			"Seeded rye",
		]);
		await untilShown(frame, ["Country sourdough", "Cardamom bun", "Seeded rye"]);
		await said(page, "Cardamom bun put back");
		await toast.waitFor({ state: "detached" });
		expect(await focusInPage(frame)).toMatch(/^li:Cardamom bun/);

		// From the panel too: Remove this item; the toast goes by itself after 8 seconds.
		const third = await boxIn(frame, "li", 2);
		await page.mouse.click(third.x + 40, third.y + 10);
		await page.locator(panel).getByRole("button", { name: "Remove this item" }).click();
		expect(await eventually(names, (list) => list.length === 2)).toEqual(["Country sourdough", "Cardamom bun"]);
		await toast.getByText("Seeded rye removed").waitFor();
		await page.mouse.move(700, 880);
		await toast.waitFor({ state: "detached", timeout: 12_000 });
	});

	test("Duplicate puts a copy after its item; Add makes a new item, its panel open", async () => {
		await reset();
		const first = await boxIn(frame, "li", 0);
		await page.mouse.click(first.x + 40, first.y + 10);
		await page.locator(bar).getByRole("button", { name: "Duplicate" }).click();
		await said(page, "Country sourdough duplicated");
		expect(await eventually(names, (list) => list.length === 4)).toEqual([
			"Country sourdough",
			"Country sourdough",
			"Cardamom bun",
			"Seeded rye",
		]);
		await untilShown(frame, ["Country sourdough", "Country sourdough", "Cardamom bun", "Seeded rye"]);
		// The copy is the one selected now.
		await page.locator(panel).locator("[data-wc-item-panel-position]", { hasText: "item 2 of 4" }).waitFor();
		await page.locator(panel).getByRole("button", { name: "Done" }).click();

		await frame.locator("[data-wc-loop-add]").scrollIntoViewIfNeeded();
		// The card is drawn on the place made for it at the end of the list, under the last item.
		let off = Number.POSITIVE_INFINITY;
		for (let attempt = 0; attempt < 10 && off > 1; attempt++) {
			await settled(page);
			const place = await boxIn(frame, "[data-wc-loop-add]");
			const card = await page.locator("[data-wc-loop-add-card]").boundingBox();
			off = card
				? Math.max(Math.abs(card.y - place.y), Math.abs(card.x - place.x), Math.abs(card.height - place.height))
				: off;
			if (off > 1) await page.waitForTimeout(50);
		}
		expect(off).toBeLessThanOrEqual(1);
		const add = await boxIn(frame, "[data-wc-loop-add]");
		await page.mouse.click(add.x + add.width / 2, add.y + add.height / 2);
		await said(page, "Item added to Our bakes");
		expect(await eventually(names, (list) => list.length === 5)).toHaveLength(5);
		const side = page.locator(panel);
		await side.locator("[data-wc-item-panel-position]", { hasText: "Our bakes · item 5 of 5" }).waitFor();
		await side.getByLabel("Name").fill("Almond croissant");
		expect(await eventually(names, (list) => list[4] === "Almond croissant")).toEqual([
			"Country sourdough",
			"Country sourdough",
			"Cardamom bun",
			"Seeded rye",
			"Almond croissant",
		]);
		await untilShown(frame, [
			"Country sourdough",
			"Country sourdough",
			"Cardamom bun",
			"Seeded rye",
			"Almond croissant",
		]);
		await page.keyboard.press("Escape");
	});

	test("Tab goes through the items and the Add card in the page's order; Enter on the card adds", async () => {
		await reset();
		await frame.locator("h1").click();
		await page.keyboard.press("Escape");
		await page.keyboard.press("Tab");
		expect(await focusInPage(frame)).toBe("li:Country sourdough€");
		await page.keyboard.press("Tab");
		expect(await focusInPage(frame)).toBe("li:Cardamom bun€3.20");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		expect(await frame.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
			"Add an item to Our bakes",
		);
		await page.locator("[data-wc-loop-add-card]").waitFor();
		await page.keyboard.press("Shift+Tab");
		expect(await focusInPage(frame)).toBe("li:Seeded rye€5.90");
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Shift+Tab");
		expect(await focusInPage(frame)).toBe("h1:Menu");

		// Enter on the card adds an item.
		for (let step = 0; step < 4; step++) await page.keyboard.press("Tab");
		await page.keyboard.press("Enter");
		expect(await eventually(names, (list) => list.length === 4)).toHaveLength(4);
		await page.locator(panel).locator("[data-wc-item-panel-position]", { hasText: "item 4 of 4" }).waitFor();
		await page.keyboard.press("Escape");
	});

	test("a query Loop's item shows where it comes from, and opens its Entry's page", async () => {
		await reset();
		await frame.locator("section h3").first().scrollIntoViewIfNeeded();
		const post = await boxIn(frame, "section h3", 0);
		await page.mouse.move(post.x + 10, post.y + 5);
		const chip = page.locator("[data-wc-query-chip]");
		await chip.locator("[data-wc-query-from]", { hasText: "These are your latest Blog posts" }).waitFor();
		// Query items carry no mark at rest, and nothing in them is changed here.
		expect(await page.locator('[data-wc-item-mark="rest"]').count()).toBe(3);
		// The pointer can reach the chip: it stays.
		const shown = await chip.boundingBox();
		if (!shown) throw new Error("No chip.");
		await page.mouse.move(shown.x + 20, shown.y + 10, { steps: 4 });
		await page.waitForTimeout(400);
		expect(await chip.count()).toBe(1);

		await chip.getByRole("button", { name: "Open this Entry" }).click();
		const opened = await framedAt(page, "/blog/spring-menu");
		expect(await opened.locator("h1").textContent()).toBe("Spring menu");
		await page.goBack();
		frame = await framedAt(page, path);
		await page.locator("[data-wc-loop-add-card]").waitFor();

		// From the keyboard: focus on the item says where it comes from; Enter opens it.
		await frame.locator("section").nth(1).focus();
		await said(page, "Our sourdough starter, explained. These are your latest Blog posts. Press Enter to open it");
		await chip.waitFor();
		await page.keyboard.press("Enter");
		const starter = await framedAt(page, "/blog/our-sourdough-starter-explained");
		expect(await starter.locator("h1").textContent()).toBe("Our sourdough starter, explained");
		await page.goBack();
		frame = await framedAt(page, path);
		await page.locator("[data-wc-loop-add-card]").waitFor();
	});

	test("the shell passes the accessibility checks, light and dark; Preview takes the items' marks away", async () => {
		await reset();
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			const second = await boxIn(frame, "li", 1);
			await page.mouse.click(second.x + 40, second.y + 10);
			await page.locator(panel).getByLabel("Name").waitFor();
			await page.mouse.move(700, 880);
			await expectNoAxeViolations(page, `an item selected, its panel open (${theme})`);
			await page.locator(panel).getByRole("button", { name: "Done" }).click();
			await page.locator(panel).waitFor({ state: "detached" });
			await frame.locator("section h3").first().scrollIntoViewIfNeeded();
			const post = await boxIn(frame, "section h3", 0);
			await page.mouse.move(post.x + 10, post.y + 5);
			await page.locator("[data-wc-query-chip]").waitFor();
			await expectNoAxeViolations(page, `a query item's chip (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });
		await page.mouse.move(700, 880);
		// The chip goes once the pointer has left its item: nothing changes under the keyboard's walk.
		await page.locator("[data-wc-query-chip]").waitFor({ state: "detached" });
		await expectAccessibleScreen(page, "client editing with Loop items");

		await page.locator('[data-wc-segment="preview"]').click();
		await settled(page);
		expect(await page.locator("[data-wc-item-mark]").count()).toBe(0);
		expect(await page.locator("[data-wc-loop-add-card]").count()).toBe(0);
		expect(await frame.locator("[data-wc-loop-add]").count()).toBe(0);
		expect(await frame.locator("li").first().getAttribute("tabindex")).toBeNull();
		const second = await boxIn(frame, "li", 1);
		await page.mouse.click(second.x + 40, second.y + 10);
		await settled(page);
		expect(await page.locator(bar).count()).toBe(0);
		expect(await page.locator(panel).count()).toBe(0);
		expect(await shownNames(frame)).toEqual(["Country sourdough", "Cardamom bun", "Seeded rye"]);
		await page.locator('[data-wc-segment="edit"]').click();
		await page.locator('[data-wc-item-mark="rest"]').nth(2).waitFor();
		expect(await frame.locator("li").first().getAttribute("tabindex")).toBe("0");
		expect(await frame.locator("li h2").first().getAttribute("contenteditable")).toBe("false");
	});
});
