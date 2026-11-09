// The Filter builder and the Filter's layout presets in a real browser (#98, GLOSSARY.md › Filter).
// The builder: Site › Filters and each tab of a Filter's builder in light and dark (axe and the
// keyboard; the live preview shows the Site's own page in a frame that runs no script, which axe can't
// look inside, so it is left out), its menus from the keyboard, and the control list's moves made with
// Alt and the arrows, each said in a live region and kept by what is saved. On the Site: each layout
// preset in light and dark, at a desktop's width and a phone's; a top bar's dropdown and the phone
// drawer opened from the keyboard; the drawer holding its choices until its "Show" button; a range's
// slider moved from the keyboard with its value in its box; and a search box placed on its own in the
// header, part of the same Filter.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { buildShop, SHOP_MARKUP, type Shop } from "../filters/shop.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let shop: Shop;
let staff: TestAccount;
const slug = "presets";

/** The live preview shows the Site's own page and runs no script: axe can't look inside it. */
const PREVIEW = { exclude: ["iframe[title^='Live preview']"] };

/** The controls of the shop, with ids that say what they are, as the builder gives them. */
const IDS = ["search", "category", "baker", "vegan", "price", "baked", "sort", "chips", "count"];

beforeAll(async () => {
	install = await startBrowserInstall();
	shop = await buildShop(install.install, slug, async (siteId) => {
		await install.goLive(siteId);
		return new URL(install.liveUrl(slug, "/")).origin;
	});
	const { siteId } = shop;
	const api = shop.staff.api;
	await api.languages.add({ siteId, code: "it" });
	const { filter } = await api.filters.get({ siteId, filterId: shop.filterId });
	await api.filters.saveDraft({
		siteId,
		filterId: shop.filterId,
		controls: filter.draft.controls.map((control, index) => ({ ...control, id: IDS[index] })),
	});
	await api.filters.publish({ siteId, filterId: shop.filterId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><p><a href="/">Acme Bakery</a></p>{{@filter shop for="products" control="search"}}</header><main>{{@outlet}}</main><footer><p>Open every day.</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const archive = await api.templates.saveArchiveTemplateMarkup({
		siteId,
		postTypeId: shop.productsId,
		markup: `<h1>Shop</h1>${SHOP_MARKUP}`,
	});
	await api.templates.publish({ siteId, templateId: archive.template.id });
	staff = (await install.install.createStaff({ workspaces: [shop.workspaceId] })).account;
});

afterAll(async () => {
	await install.close();
});

/** Opens the Filter builder, signed in as Staff, and waits for the preview to show the Draft. */
async function openBuilder(theme: Theme, tab?: string): Promise<Page> {
	const page = await install.newPage(theme);
	await page.setViewportSize({ width: 1600, height: 1000 });
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${shop.siteId}/filters/${shop.filterId}${tab ? `?tab=${tab}` : ""}`));
	await page.getByText(/real counts: \d+/).waitFor();
	return page;
}

/** Publishes the shop's Filter with `change` to its Draft. */
async function publishFilter(change: Record<string, unknown>): Promise<void> {
	const { siteId, filterId } = shop;
	await shop.staff.api.filters.saveDraft({ siteId, filterId, ...change });
	await shop.staff.api.filters.publish({ siteId, filterId });
}

for (const theme of THEMES) {
	describe(`the Filter builder, ${theme}`, () => {
		test("Site › Filters", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${shop.siteId}/filters`));
			await page.getByRole("link", { name: "shop", exact: true }).waitFor();

			await expectAccessibleScreen(page, `Site › Filters (${theme})`);
			await expectOverlayUsable(page, page.getByRole("button", { name: "New Filter" }), "dialog", "New Filter");
		});

		for (const tab of ["controls", "layout", "settings", "translations"]) {
			test(`the ${tab} tab`, async () => {
				const page = await openBuilder(theme, tab);

				await expectAccessibleScreen(page, `Filter builder, ${tab} (${theme})`, PREVIEW);
			});
		}
	});
}

describe("the Filter builder from the keyboard", () => {
	test("its menus: Add control and a control's actions", async () => {
		const page = await openBuilder("light");

		await expectOverlayUsable(page, page.getByRole("button", { name: "Add control" }), "menu", "Add control", PREVIEW);
		await expectOverlayUsable(
			page,
			page.getByRole("button", { name: "Actions for Baker" }),
			"menu",
			"A control's actions",
			PREVIEW,
		);
	});

	test("Alt with the arrows moves a control, said in a live region and kept when saved", async () => {
		const page = await openBuilder("light");
		const search = page.locator('[data-control="search"]');
		await search.focus();
		await page.keyboard.press("Alt+ArrowDown");

		await page.getByRole("status").filter({ hasText: "Moved Search the shop: 2 of 9." }).waitFor({ state: "attached" });
		expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.control)).toBe("search");
		await page.keyboard.press("Alt+ArrowDown");
		await page.getByRole("status").filter({ hasText: "Moved Search the shop: 3 of 9." }).waitFor({ state: "attached" });
		await page.keyboard.press("Alt+ArrowUp");
		await page.getByRole("status").filter({ hasText: "Moved Search the shop: 2 of 9." }).waitFor({ state: "attached" });

		// The preview shows the new order before anything is saved.
		await page.getByRole("button", { name: "Save draft" }).focus();
		await page.keyboard.press("Enter");
		await page.getByText("The Filter's Draft is saved.").waitFor();
		const { filter } = await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId });
		expect(filter.draft.controls.map((control) => control.id).slice(0, 3)).toEqual(["category", "search", "baker"]);
		await shop.staff.api.filters.saveDraft({
			siteId: shop.siteId,
			filterId: shop.filterId,
			controls: [...filter.draft.controls].sort((a, b) => IDS.indexOf(a.id) - IDS.indexOf(b.id)),
		});
	});

	test("adding a control from its menu selects it and says where it went", async () => {
		const page = await openBuilder("light");
		await shop.staff.api.filters.saveDraft({
			siteId: shop.siteId,
			filterId: shop.filterId,
			controls: (
				await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId })
			).filter.draft.controls.filter((control) => control.type !== "count"),
		});
		await page.reload();
		await page.getByText(/real counts: \d+/).waitFor();
		await page.getByRole("button", { name: "Add control" }).focus();
		await page.keyboard.press("Enter");
		await page.getByRole("menuitem", { name: "Result count" }).click();

		await page
			.getByRole("status")
			.filter({ hasText: "Added Result count as control 9." })
			.waitFor({ state: "attached" });
		expect(await page.getByRole("heading", { name: "Result count settings" }).count()).toBe(1);
		await expectNoAxeViolations(page, "a control just added", [], PREVIEW);
		await shop.staff.api.filters.saveDraft({
			siteId: shop.siteId,
			filterId: shop.filterId,
			controls: (await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId })).filter.published
				?.controls,
		});
	});
});

/** A page of the shop on its live domain, at a desktop's width or a phone's. */
async function openShop(theme: Theme, path: string, phone = false): Promise<Page> {
	const page = await install.newPage(theme);
	if (phone) await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(install.liveUrl(slug, path));
	await page.waitForLoadState("load");
	return page;
}

for (const [layout, phone] of [
	["sidebar", "drawer"],
	["topbar", "same"],
	["drawer", "drawer"],
] as const) {
	describe(`the ${layout} preset on the Site`, () => {
		beforeAll(async () => {
			await publishFilter({ layout, phone, mode: "live" });
		});

		for (const theme of THEMES) {
			test(`at a desktop's width and a phone's, ${theme}`, async () => {
				const wide = await openShop(theme, "/shop?category=bread,pastries");
				await expectAccessibleScreen(wide, `${layout}, desktop (${theme})`);
				const narrow = await openShop(theme, "/shop?category=bread,pastries", true);
				await expectAccessibleScreen(narrow, `${layout}, phone (${theme})`);
			});
		}
	});
}

describe("from the keyboard on the Site", () => {
	test("a top bar's dropdown opens from its button, its options next in the tab order, Escape closing it", async () => {
		await publishFilter({ layout: "topbar", phone: "same", mode: "live" });
		const page = await openShop("light", "/shop");
		const button = page.getByRole("button", { name: "Category" });
		await button.focus();
		await page.keyboard.press("Enter");
		const panel = page.locator("#wc-filter-shop-2-panel");
		await panel.waitFor({ state: "visible" });

		await expectNoAxeViolations(page, "a top bar's dropdown, open");
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("value"))).toBe("bread");
		// Ticking applies at once in Live mode, and the dropdown stays open with focus where it was.
		await page.keyboard.press("Space");
		await page.waitForURL((url) => url.search === "?category=bread");
		await panel.waitFor({ state: "visible" });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("value"))).toBe("bread");
		await page.keyboard.press("Escape");
		await panel.waitFor({ state: "hidden" });
		expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
	});

	test("the phone drawer opens as a dialog and holds its choices until its Show button", async () => {
		await publishFilter({ layout: "sidebar", phone: "drawer", mode: "live" });
		const page = await openShop("light", "/shop", true);
		const open = page.getByRole("button", { name: "Filters" });

		await expectOverlayUsable(page, open, "dialog", "the phone drawer");
		await open.focus();
		await page.keyboard.press("Enter");
		const drawer = page.getByRole("dialog", { name: "Filters" });
		await drawer.waitFor({ state: "visible" });
		await drawer.getByRole("checkbox", { name: /^Bread/ }).focus();
		await page.keyboard.press("Space");

		// Nothing applies yet: the Show button says what the choice would list.
		const show = drawer.getByRole("button", { name: /^Show/ });
		await page.waitForFunction(() => document.querySelector(".wc-filter-show")?.textContent === "Show 3 products");
		expect(new URL(page.url()).search).toBe("");
		await show.focus();
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => url.search === "?category=bread");
		await drawer.waitFor({ state: "hidden" });
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("wc-filter-shop-open");
		expect(await page.getByRole("button", { name: "Filters 1 chosen" }).count()).toBe(1);
	});

	test("a range's slider moves from the keyboard, its value in its box", async () => {
		const { filter } = await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId });
		await publishFilter({
			layout: "sidebar",
			phone: "same",
			controls: filter.draft.controls.map((control) =>
				control.id === "price" ? { ...control, slider: { min: 0, max: 30, step: 1 } } : control,
			),
		});
		const page = await openShop("light", "/shop");
		const from = page.locator("#wc-filter-shop-5-min-slider");
		await from.waitFor({ state: "visible" });
		await from.focus();
		for (let press = 0; press < 4; press++) await page.keyboard.press("ArrowRight");

		expect(await page.locator("#wc-filter-shop-5-min").inputValue()).toBe("4");
		await page.waitForURL((url) => url.search === "?price=4-");
		expect(await page.locator("#wc-filter-shop-5-min-slider").inputValue()).toBe("4");
		await expectAccessibleScreen(page, "a range with its slider");
	});

	test("a search box placed on its own in the header belongs to the Filter", async () => {
		const page = await openShop("light", "/shop?category=pastries");
		const search = page.locator("header").getByRole("searchbox", { name: "Search the shop" });
		await search.fill("bun");

		await page.waitForURL((url) => url.search === "?category=pastries&q=bun");
		expect(await page.locator("main > ul > li").allTextContents()).toEqual(["Cinnamon bun"]);
		expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
	});
});

describe("the visual builder", () => {
	test("Open in visual builder opens the Template holding the Filter, the Filter selected", async () => {
		const page = await openBuilder("light", "layout");
		await page.getByRole("link", { name: "Open Products · Archive template in the visual builder" }).click();
		await page.getByRole("tree", { name: "Layers" }).waitFor();

		const selected = page.getByRole("treeitem", { selected: true });
		expect(await selected.count()).toBe(1);
		expect(await selected.textContent()).toContain("Filter shop");
	});

	test("its insert menu places a Filter, or one of its controls on its own", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, staff);
		await page.goto(
			install.adminUrl(`/builder/${shop.siteId}/archive-template/${shop.productsId}?filter=${shop.filterId}`),
		);
		await page.getByRole("tree", { name: "Layers" }).waitFor();
		await page.getByRole("button", { name: "Insert" }).click();
		await page.getByRole("combobox", { name: "Find an element" }).fill("Filter");
		await page.keyboard.press("Enter");
		await page.getByRole("combobox", { name: "Filter" }).selectOption({ label: "shop (products)" });
		await page.getByRole("combobox", { name: "Show" }).selectOption({ label: "Only Search the shop (search)" });
		await expectNoAxeViolations(page, "the insert menu's Filter step", ["region"], {
			exclude: ["iframe[title^='Canvas']"],
		});
		await page.getByRole("button", { name: "Insert", exact: true }).last().click();
		await page.keyboard.press("ControlOrMeta+s");
		await page.getByRole("button", { name: "Save" }).and(page.locator("[disabled]")).waitFor();

		const { markup } = await shop.staff.api.templates.getArchiveTemplateMarkup({
			siteId: shop.siteId,
			postTypeId: shop.productsId,
		});
		expect(markup?.draft).toContain('{{@filter shop for="products" control="search"}}');
	});
});
