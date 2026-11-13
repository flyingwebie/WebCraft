// Filters in a real browser (GLOSSARY.md › Filter), in the device's light and dark themes: the shop's
// Filter beside its Loop, checked with axe-core and the keyboard under the Site's strict policy. With
// JavaScript the page never reloads: Live mode updates the Loop as a choice changes and announces the
// count, On submit mode waits for Apply, focus stays where it was and Back goes to the choices before.
// Without JavaScript the form is sent and the page loads at its normal address.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { buildShop, SHOP_MARKUP, type Shop } from "../filters/shop.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let shop: Shop;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	shop = await buildShop(install.install, slug, async (siteId) => {
		await install.goLive(siteId);
		return new URL(install.liveUrl(slug, "/")).origin;
	});
	const { staff, siteId } = shop;
	const { template } = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><p><a href="/">Acme Bakery</a></p></header><main>{{@outlet}}</main><footer><p>Open every day.</p></footer>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const archive = await staff.api.templates.saveArchiveTemplateMarkup({
		siteId,
		postTypeId: shop.productsId,
		markup: `<h1>Shop</h1>${SHOP_MARKUP}`,
	});
	await staff.api.templates.publish({ siteId, templateId: archive.template.id });
});

afterAll(async () => {
	await install.close();
});

/** The titles the Loop lists, in order. */
const listed = (page: Page) => page.locator("main > ul > li").allTextContents();

/** Opens a page of the shop and waits for its scripts. */
async function open(page: Page, path: string): Promise<void> {
	await page.goto(install.liveUrl(slug, path));
	await page.waitForLoadState("load");
}

for (const theme of THEMES) {
	describe(`a Filter on a Site's page, ${theme}`, () => {
		for (const [name, path] of [
			["the shop without choices", "/shop"],
			["the shop with choices, chips and a second page", "/shop?category=bread,pastries&vegan=1"],
			["the shop with nothing matching", "/shop?category=cakes&vegan=1"],
		] as const) {
			test(name, async () => {
				await expectSafePage(await install.install.request(install.liveUrl(slug, path)));
				const page = await install.newPage(theme);
				await open(page, path);

				await expectAccessibleScreen(page, `${name} (${theme})`);
			});
		}
	});
}

describe("with JavaScript", () => {
	test("Live mode: ticking an option updates the Loop in place, keeps focus and announces the count", async () => {
		const page = await install.newPage("light");
		await open(page, "/shop");
		// A page that never reloads keeps what its scripts set.
		await page.evaluate(() => Object.assign(window, { wcStayed: true }));
		expect(await page.getByRole("button", { name: "Apply" }).isHidden()).toBe(true);

		const bread = page.getByRole("checkbox", { name: /^Bread/ });
		await bread.focus();
		await page.keyboard.press("Space");
		await page.waitForURL((url) => url.search === "?category=bread");

		await expect(listed(page)).resolves.toEqual(["Country sourdough", "Rosemary focaccia", "Rye & caraway"]);
		expect(await page.evaluate(() => (window as { wcStayed?: boolean }).wcStayed)).toBe(true);
		expect(await page.getByRole("checkbox", { name: /^Bread/ }).evaluate((box) => box === document.activeElement)).toBe(
			true,
		);
		await page.getByRole("status").filter({ hasText: "3 products" }).waitFor();
		await expect(page.getByRole("checkbox", { name: /^Bread/ }).isChecked()).resolves.toBe(true);
	});

	test("typing in the search box searches after a pause, the box keeping its text and focus", async () => {
		const page = await install.newPage("light");
		await open(page, "/shop");
		await page.evaluate(() => Object.assign(window, { wcStayed: true }));

		const box = page.getByRole("searchbox", { name: "Search the shop" });
		await box.focus();
		await page.keyboard.type("chocolat");
		await page.waitForURL((url) => url.searchParams.get("q") === "chocolat");

		await expect(listed(page)).resolves.toEqual(["Pain au chocolat"]);
		expect(await page.evaluate(() => (window as { wcStayed?: boolean }).wcStayed)).toBe(true);
		const focused = page.getByRole("searchbox", { name: "Search the shop" });
		expect(await focused.evaluate((element) => element === document.activeElement)).toBe(true);
		expect(await focused.inputValue()).toBe("chocolat");
		await page.getByRole("status").filter({ hasText: "1 product" }).waitFor();
	});

	test("a chip removes its choice from the keyboard; Back shows the choices before", async () => {
		const page = await install.newPage("light");
		await open(page, "/shop?category=bread,pastries&vegan=1");
		await page.evaluate(() => Object.assign(window, { wcStayed: true }));

		await page.getByRole("link", { name: "Remove Vegan only" }).focus();
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => url.search === "?category=bread,pastries");
		await expect(listed(page)).resolves.toEqual([
			"Butter croissant",
			"Cinnamon bun",
			"Country sourdough",
			"Pain au chocolat",
		]);
		// The chip is gone: focus goes to the chip before it.
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Pastries ×");

		await page.goBack();
		await page.waitForURL((url) => url.search === "?category=bread,pastries&vegan=1");
		await page.getByRole("status").filter({ hasText: "2 products" }).waitFor();
		await expect(listed(page)).resolves.toEqual(["Cinnamon bun", "Rosemary focaccia"]);
		expect(await page.evaluate(() => (window as { wcStayed?: boolean }).wcStayed)).toBe(true);
	});

	test("a filtered Loop's pages swap in place, keeping the choices", async () => {
		const page = await install.newPage("light");
		await open(page, "/shop?category=bread,pastries");
		await page.evaluate(() => Object.assign(window, { wcStayed: true }));

		await page.getByRole("link", { name: "Next" }).click();
		await page.waitForURL((url) => url.search === "?category=bread,pastries&page=2");
		await expect(listed(page)).resolves.toEqual(["Rosemary focaccia", "Rye & caraway"]);
		expect(await page.evaluate(() => (window as { wcStayed?: boolean }).wcStayed)).toBe(true);
	});

	test("On submit mode: nothing changes until Apply is pressed", async () => {
		await shop.staff.api.filters.saveDraft({ siteId: shop.siteId, filterId: shop.filterId, mode: "submit" });
		await shop.staff.api.filters.publish({ siteId: shop.siteId, filterId: shop.filterId });
		try {
			const page = await install.newPage("light");
			await open(page, "/shop");
			await page.evaluate(() => Object.assign(window, { wcStayed: true }));

			await page.getByRole("checkbox", { name: /^Cakes/ }).check();
			await page.waitForTimeout(600);
			expect(new URL(page.url()).search).toBe("");
			await expect(listed(page)).resolves.toHaveLength(4);

			await page.getByRole("button", { name: "Apply" }).focus();
			await page.keyboard.press("Enter");
			await page.waitForURL((url) => url.search === "?category=cakes");
			await expect(listed(page)).resolves.toEqual(["Birthday cake"]);
			expect(await page.evaluate(() => (window as { wcStayed?: boolean }).wcStayed)).toBe(true);
			await page.getByRole("status").filter({ hasText: "1 product" }).waitFor();
		} finally {
			await shop.staff.api.filters.saveDraft({ siteId: shop.siteId, filterId: shop.filterId, mode: "live" });
			await shop.staff.api.filters.publish({ siteId: shop.siteId, filterId: shop.filterId });
		}
	});
});

describe("without JavaScript", () => {
	test("the form is sent and the page loads at the normal address of the choices", async () => {
		const page = await install.newPage("light", { javaScript: false });
		await open(page, "/shop");

		await page.getByRole("checkbox", { name: /^Pastries/ }).check();
		await page.getByRole("checkbox", { name: /^Bread/ }).check();
		await page.getByLabel("From").first().fill("3");
		await page.getByRole("button", { name: "Apply" }).click();
		await page.waitForURL((url) => url.search === "?category=bread,pastries&price=3-");

		await expect(listed(page)).resolves.toEqual([
			"Cinnamon bun",
			"Country sourdough",
			"Pain au chocolat",
			"Rosemary focaccia",
		]);
	});
});
