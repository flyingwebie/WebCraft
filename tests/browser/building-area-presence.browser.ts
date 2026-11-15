// Presence on what isn't typed in, the amber dot of each changed Loop item, and a finger's words, in
// client editing (BA-35; SPEC 13.2 and 13.3), in Chromium:
// - two Members on one page: while one has a photo's or a link's popover open, or a Loop item
//   selected, the other sees an outline in their colour on it with their name; it moves with them (to
//   text being typed) and goes when they leave; the shell passes the accessibility checks with it;
// - each Loop item changed and not published has the amber dot on its outline's corner: a changed one
//   and a moved one, not the others;
// - with a finger (a coarse pointer) the chips say "Tap to edit", with a mouse "Click to edit".
// The building area's own test of the old editing bar's "others see who is on an image or a Loop item,
// outlined with their name" (`edit-mode-in-place.browser.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import type { Frame, Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let api: ApiClient;
let pat: TestAccount;
let theo: TestAccount;
let siteId: string;
let loopId: string;
let itemIds: string[] = [];
const slug = "bakery";
const path = "/recipes/menu";

const BAKES = [
	{ name: "Country sourdough", price: "€6.50" },
	{ name: "Cardamom bun", price: "€3.20" },
	{ name: "Seeded rye", price: "€5.90" },
];

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	({ api } = await local.superadmin());
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	pat = (await local.createMember({ workspaceId, role: "editor", name: "Pat Baker" })).account;
	theo = (await local.createMember({ workspaceId, role: "editor", name: "Theo Tester" })).account;
	const { media } = await api.media.upload({
		siteId,
		file: upload(await photo({ width: 640, height: 480 }), "loaf.jpg"),
	});
	await local.drainJobs();

	const { loop } = await api.loops.create({
		siteId,
		name: "our-bakes",
		source: "items",
		fields: [
			{ key: "name", label: "Name", type: "text", required: true },
			{ key: "price", label: "Price", type: "text" },
		],
	});
	loopId = loop.id;
	await resetLoop();

	const { postType } = await api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "photo", label: "Hero photo", type: "media" },
			{ key: "cta", label: "Order button", type: "link" },
		],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: [
			"<article><h1>{{ title }}</h1>",
			'<img src="{{ photo }}" width="320" height="240">',
			'<p><a href="{{ cta.url }}">{{ cta.text }}</a></p>',
			"<ul>{{@loop our-bakes as bake}}<li><h2>{{ bake.name }}</h2><p>{{ bake.price }}</p></li>{{/loop}}</ul>",
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Menu",
		slug: "menu",
		fields: { photo: media.id, cta: { url: "/order", text: "Order a loaf" } },
	});
	await api.entries.publish({ siteId, entryId: entry.id });
});

afterAll(async () => {
	await install?.close();
});

/** Puts the Loop's items back as the test starts, published: nothing of them is changed. */
async function resetLoop(): Promise<void> {
	await api.loops.saveItems({ siteId, loopId, items: BAKES });
	await api.loops.publish({ siteId, loopId });
	itemIds = (await api.loops.get({ siteId, loopId })).loop.draft.items.map((item) => String(item.id));
}

const itemKey = (index: number) => `loop:${loopId}:${itemIds[index]}`;

/** Opens the page in the shell (the session's cookies are there: the link was followed once). */
async function open(page: Page): Promise<Frame> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
	for (let attempt = 0; attempt < 150; attempt++) {
		const handle = await page.locator("iframe[data-wc-frame]").elementHandle();
		const frame = await handle?.contentFrame();
		if (frame && new URL(frame.url()).pathname === path) {
			await frame.locator("h1[contenteditable]").waitFor();
			await frame.locator("li").first().waitFor();
			await page.locator("[data-wc-item-marks] [data-wc-item-mark]").first().waitFor({ state: "attached" });
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${path}.`);
}

type Box = { x: number; y: number; width: number; height: number };

/** Waits until someone's outline with `name` on its chip is drawn around `target`'s box (within a few pixels). */
async function outlinedFor(page: Page, frame: Frame, target: string, name: string, nth = 0): Promise<void> {
	const deadline = Date.now() + 10_000;
	let last = "nothing";
	while (Date.now() < deadline) {
		await settled(page);
		const region = await frame.locator(target).nth(nth).boundingBox();
		const chips = await page.locator("[data-wc-mark-name]").allTextContents();
		const boxes = (await page.locator('[data-wc-mark="person"]').evaluateAll((all) =>
			all
				.filter((each) => !(each as HTMLElement).classList.contains("hidden"))
				.map((each) => {
					const box = each.getBoundingClientRect();
					return { x: box.x, y: box.y, width: box.width, height: box.height };
				}),
		)) as Box[];
		const around = (box: Box) =>
			region !== null &&
			Math.abs(box.x + box.width / 2 - (region.x + region.width / 2)) < 10 &&
			Math.abs(box.y + box.height / 2 - (region.y + region.height / 2)) < 10 &&
			box.width >= region.width - 2;
		if (chips.some((chip) => chip.includes(name)) && boxes.some(around)) return;
		last = JSON.stringify({ region, chips, boxes });
		await page.waitForTimeout(100);
	}
	throw new Error(`No outline for ${name} around ${target}: ${last}`);
}

/** Waits until nobody's name with `name` is drawn. */
async function goneFor(page: Page, name: string): Promise<void> {
	await page.waitForFunction(
		(name) =>
			![...document.querySelectorAll("[data-wc-mark-name]")].some(
				(chip) => !chip.closest(".hidden") && !chip.classList.contains("hidden") && chip.textContent?.includes(name),
			),
		name,
		{ timeout: 10_000 },
	);
}

describe("Presence on photos, links and Loop items, for two Members", () => {
	let mine: Page;
	let theirs: Page;
	let mineFrame: Frame;
	let theirsFrame: Frame;

	beforeAll(async () => {
		mine = await install.newPage("light");
		await mine.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, mine, { as: pat, siteId, slug, open: `/page${path}` });
		mineFrame = await open(mine);
		theirs = await install.newPage("light");
		await theirs.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, theirs, { as: theo, siteId, slug, open: `/page${path}` });
		theirsFrame = await open(theirs);
	});

	afterAll(async () => {
		await mine?.context().close();
		await theirs?.context().close();
	});

	test("others see who is on a photo, a link or a Loop item, outlined in their colour with their name", async () => {
		// A photo: Pat opens its popover; Theo sees Pat on it.
		await mineFrame.locator('img[data-wc-field="photo"]').click();
		await mine.locator('[data-wc-popover="photo"]').waitFor();
		await outlinedFor(theirs, theirsFrame, 'img[data-wc-field="photo"]', "Pat Baker");
		for (const theme of ["light", "dark"] as const) {
			await theirs.emulateMedia({ colorScheme: theme });
			await expectNoAxeViolations(theirs, `Client editing › someone on a photo (${theme})`);
		}
		await theirs.emulateMedia({ colorScheme: "light" });
		// The popover put away: Pat is nowhere, and the mark goes.
		await mine.keyboard.press("Escape");
		await mine.locator('[data-wc-popover="photo"]').waitFor({ state: "detached" });
		await goneFor(theirs, "Pat Baker");

		// A link, the same.
		await mineFrame.locator('a[data-wc-type="link"]').click();
		await mine.locator('[data-wc-popover="link"]').waitFor();
		await outlinedFor(theirs, theirsFrame, 'a[data-wc-type="link"]', "Pat Baker");
		await mine.keyboard.press("Escape");
		await mine.locator('[data-wc-popover="link"]').waitFor({ state: "detached" });
		await goneFor(theirs, "Pat Baker");

		// A Loop item: Pat selects the second; Theo sees Pat on that item, and on no other.
		const second = await mineFrame.locator("li").nth(1).boundingBox();
		if (!second) throw new Error("No second item.");
		await mine.mouse.click(second.x + 40, second.y + 10);
		await mine.locator("[data-wc-item-panel]").waitFor();
		await outlinedFor(theirs, theirsFrame, "li", "Pat Baker", 1);
		expect(
			await theirs
				.locator("[data-wc-person-item]")
				.evaluateAll((all) => all.map((each) => each.getAttribute("data-wc-person-item"))),
		).toEqual([itemKey(1)]);
		for (const theme of ["light", "dark"] as const) {
			await theirs.emulateMedia({ colorScheme: theme });
			await expectNoAxeViolations(theirs, `Client editing › someone on a Loop item (${theme})`);
		}
		await theirs.emulateMedia({ colorScheme: "light" });

		// Pat goes on to type the title: Theo sees Pat there, and no longer on the item.
		await mineFrame.locator("h1").click();
		await outlinedFor(theirs, theirsFrame, "h1", "Pat Baker");
		await theirs.locator("[data-wc-person-item]").waitFor({ state: "detached" });

		// The other way round: Theo selects the third item, Pat sees Theo on it.
		const third = await theirsFrame.locator("li").nth(2).boundingBox();
		if (!third) throw new Error("No third item.");
		await theirs.mouse.click(third.x + 40, third.y + 10);
		await theirs.locator("[data-wc-item-panel]").waitFor();
		await outlinedFor(mine, mineFrame, "li", "Theo Tester", 2);

		// Both leave: no marks.
		await mine.keyboard.press("Escape");
		await theirs.getByRole("button", { name: "Done" }).click();
		// Done gives focus back to the item; Escape there puts it away.
		await theirs.locator("[data-wc-item-panel]").waitFor({ state: "detached" });
		await theirs.keyboard.press("Escape");
		await goneFor(mine, "Theo Tester");
		await goneFor(theirs, "Pat Baker");
		await expectAccessibleScreen(mine, "Client editing › after Presence");
	});

	test("each Loop item changed and not published has the amber dot: a changed one and a moved one", async () => {
		await resetLoop();
		mineFrame = await open(mine);
		const dots = () =>
			mine
				.locator("[data-wc-item-marks] [data-wc-changed-item]")
				.evaluateAll((all) => all.map((each) => each.getAttribute("data-wc-changed-item")).sort());
		expect(await dots()).toEqual([]);

		// The second item's Price changed: its dot, on its outline's top left corner, and none on the others.
		const second = await mineFrame.locator("li").nth(1).boundingBox();
		if (!second) throw new Error("No second item.");
		await mine.mouse.click(second.x + 40, second.y + 10);
		const panel = mine.locator("[data-wc-item-panel]");
		await panel.getByLabel("Price").fill("€3.50");
		await mine.waitForFunction(
			(key) => document.querySelector(`[data-wc-changed-item="${key}"]`) !== null,
			itemKey(1),
			{ timeout: 10_000 },
		);
		expect(await dots()).toEqual([itemKey(1)]);
		await settled(mine);
		const dot = await mine.locator(`[data-wc-changed-item="${itemKey(1)}"]`).boundingBox();
		const item = await mineFrame.locator("li").nth(1).boundingBox();
		if (!dot || !item) throw new Error("No dot.");
		// The outline sits 6 px off the item; the dot is centred on its corner.
		expect(Math.abs(dot.x + dot.width / 2 - (item.x - 6))).toBeLessThanOrEqual(2);
		expect(Math.abs(dot.y + dot.height / 2 - (item.y - 6))).toBeLessThanOrEqual(2);
		expect(dot.width).toBe(12);
		await panel.getByRole("button", { name: "Done" }).click();
		await panel.waitFor({ state: "detached" });

		// The third moved to the top: it is dotted too; the first, in its place among the others, isn't.
		const third = await mineFrame.locator("li").nth(2).boundingBox();
		if (!third) throw new Error("No third item.");
		await mine.mouse.click(third.x + 40, third.y + 10);
		await mine.locator("[data-wc-item-panel]").getByRole("button", { name: "Done" }).click();
		for (const place of [1, 0]) {
			await mine
				.getByRole("toolbar", { name: "Tools for Seeded rye" })
				.getByRole("button", { name: "Move earlier" })
				.click();
			await mineFrame.waitForFunction(
				(place) => document.querySelectorAll("li h2")[place]?.textContent === "Seeded rye",
				place,
				{ timeout: 10_000 },
			);
		}
		await mine.waitForFunction(
			(key) => document.querySelector(`[data-wc-changed-item="${key}"]`) !== null,
			itemKey(2),
			{ timeout: 10_000 },
		);
		expect(await dots()).toEqual([itemKey(1), itemKey(2)].sort());
		for (const theme of ["light", "dark"] as const) {
			await mine.emulateMedia({ colorScheme: theme });
			await expectNoAxeViolations(mine, `Client editing › changed Loop items (${theme})`);
		}
		await mine.emulateMedia({ colorScheme: "light" });

		// Published (by Staff, whose the Loop's items are): no dot is left.
		await api.loops.publish({ siteId, loopId });
		await open(mine);
		expect(await dots()).toEqual([]);
		await resetLoop();
	});
});

describe("a finger's words", () => {
	let page: Page;
	let frame: Frame;

	beforeAll(async () => {
		page = await install.newPage("light", { touch: true });
		await page.setViewportSize({ width: 1280, height: 900 });
		await enterBuildingArea(install, page, { as: pat, siteId, slug, open: `/page${path}` });
		frame = await open(page);
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("with a coarse pointer the chips say Tap to edit; Enter's words stay for the keyboard", async () => {
		expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
		const title = await frame.locator("h1").boundingBox();
		if (!title) throw new Error("No title.");
		await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
		await page.locator('[data-wc-client-chip="hover"]', { hasText: "TitleTap to edit" }).waitFor();
		const item = await frame.locator("li").nth(0).boundingBox();
		if (!item) throw new Error("No item.");
		await page.mouse.move(item.x + 40, item.y + 10);
		await page.locator("[data-wc-item-chip]", { hasText: "Country sourdoughTap to edit" }).waitFor();
		const photoBox = await frame.locator('img[data-wc-field="photo"]').boundingBox();
		if (!photoBox) throw new Error("No photo.");
		await page.mouse.move(photoBox.x + photoBox.width / 2, photoBox.y + photoBox.height / 2);
		await page.locator('[data-wc-client-chip="hover"]', { hasText: "Hero photoTap to edit" }).waitFor();
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expectNoAxeViolations(page, `Client editing with a finger › Tap to edit (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });
		// From the keyboard it still waits for Enter.
		await frame.locator("li").first().focus();
		await page.locator("[data-wc-item-chip]", { hasText: "Country sourdoughPress Enter to edit" }).waitFor();
	});
});
