// How a Filter is laid out on a Site's page (GLOSSARY.md › Filter): its layout preset (a sidebar, a
// top bar of dropdowns, or a drawer opened by a "Filters" button), what it becomes on phones, its
// controls placed one by one elsewhere on the page, date presets and a slider for ranges. All of it
// is WebCraft's own markup and classes, styled by the Design system's base layer, never inline styles,
// and it still works as a plain GET form without JavaScript.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, fromAddress, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { buildShop, listed, optionsIn, type Shop } from "./shop.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-05-01T09:00:00Z") });
});

afterAll(async () => {
	await install.close();
});

let visitors = 0;

/** A page of a shop as a visitor of their own gets it. */
async function visit(shop: Shop, path: string): Promise<{ response: Response; html: string }> {
	const request = fromAddress(
		new Request(`${shop.origin}${path}`, { redirect: "manual" }),
		`198.51.100.${++visitors % 250}`,
	);
	const response = await install.request(request);
	const html = response.status === 200 ? await expectSafePage(response) : await response.text();
	return { response, html };
}

/** Saves the shop's Filter's Draft with `change` and publishes it. */
async function publishFilter(shop: Shop, change: Record<string, unknown>): Promise<void> {
	await shop.staff.api.filters.saveDraft({ siteId: shop.siteId, filterId: shop.filterId, ...change });
	await shop.staff.api.filters.publish({ siteId: shop.siteId, filterId: shop.filterId });
}

/** The opening tag of the shop's Filter's form. */
function formTag(html: string): string {
	return /<form class="wc-filter" id="wc-filter-shop"[^>]*>/.exec(html)?.[0] ?? "";
}

describe("layout presets", () => {
	let shop: Shop;

	beforeAll(async () => {
		shop = await buildShop(install, "presets");
	});

	test("a Filter is a sidebar that turns into a drawer on phones, unless Staff choose otherwise", async () => {
		const { filter } = await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId });
		expect(filter.draft).toMatchObject({ layout: "sidebar", phone: "drawer" });

		const { filter: saved } = await shop.staff.api.filters.saveDraft({
			siteId: shop.siteId,
			filterId: shop.filterId,
			layout: "topbar",
			phone: "same",
		});
		expect(saved.draft).toMatchObject({ layout: "topbar", phone: "same" });
		await expect(
			shop.staff.api.filters.saveDraft({ siteId: shop.siteId, filterId: shop.filterId, layout: "grid", phone: "x" }),
		).rejects.toMatchObject({
			code: "FILTER_INVALID",
			data: { problems: [{ at: "layout" }, { at: "phone" }] },
		});
		await shop.staff.api.filters.saveDraft({
			siteId: shop.siteId,
			filterId: shop.filterId,
			layout: "sidebar",
			phone: "drawer",
		});
	});
});

describe("on the Site", () => {
	let shop: Shop;

	beforeAll(async () => {
		shop = await buildShop(install, "laid-out");
	});

	/** The part of the page inside the Filter's drawer, or "" when it has none. */
	const drawerIn = (html: string) =>
		/<dialog class="wc-filter-drawer" id="wc-filter-shop-drawer"[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? "";

	test("a sidebar stacks the controls; on phones the controls with options wait in a drawer", async () => {
		const { html } = await visit(shop, "/shop");

		expect(formTag(html)).toBe(
			'<form class="wc-filter" id="wc-filter-shop" method="get" action="/shop" aria-label="Filters" data-wc-filter="shop" data-wc-mode="live" data-wc-layout="sidebar" data-wc-phone="drawer" data-wc-announce="7 products">',
		);
		// The button opens the drawer as a modal dialog, without a script where browsers allow it.
		expect(html).toContain(
			'<button type="button" class="wc-filter-open" id="wc-filter-shop-open" commandfor="wc-filter-shop-drawer" command="show-modal" aria-haspopup="dialog"><span>Filters</span></button>',
		);
		const drawer = drawerIn(html);
		expect(drawer).toContain('aria-labelledby="wc-filter-shop-drawer-title"');
		expect(drawer).toContain(
			'<button type="button" class="wc-filter-close" commandfor="wc-filter-shop-drawer" command="close" aria-label="Close"><span aria-hidden="true">×</span></button>',
		);
		// Checkboxes, the choice, the toggle and both ranges are in it; the rest stays on the page.
		for (const control of ["checkboxes", "choice", "toggle", "range"]) {
			expect(drawer).toContain(`data-wc-control="${control}"`);
		}
		for (const control of ["search", "sort", "chips", "count"]) {
			expect(drawer).not.toContain(`data-wc-control="${control}"`);
			expect(html).toContain(`data-wc-control="${control}"`);
		}
		// It applies the choices with its own button, which says how many items they list.
		expect(drawer).toContain(
			'<a class="wc-filter-drawer-reset" id="wc-filter-shop-drawer-reset" href="/shop" data-wc-filter-link>Reset</a><button type="submit" class="wc-filter-show" id="wc-filter-shop-show">Show 7 products</button>',
		);
		expect(html).toContain('<button class="wc-filter-apply" type="submit">Apply</button></form>');
		expect(listed(html)).toEqual(["Birthday cake", "Butter croissant", "Cinnamon bun", "Country sourdough"]);
	});

	test("the drawer's button says how many choices wait inside it", async () => {
		const { html } = await visit(shop, "/shop?category=bread,pastries&q=bun&vegan=1");

		// Two categories and the toggle; the search box is outside the drawer.
		expect(html).toContain(
			'<span>Filters</span> <span class="wc-filter-badge">3</span><span class="wc-visually-hidden"> chosen</span></button>',
		);
		expect(drawerIn(html)).toContain(">Show 1 product</button>");
	});

	test("a top bar shows each control with options as a dropdown button, saying how many are chosen", async () => {
		await publishFilter(shop, { layout: "topbar", phone: "same", mode: "submit" });
		const { html } = await visit(shop, "/shop?category=bread,pastries");

		expect(formTag(html)).toContain('data-wc-layout="topbar" data-wc-phone="same"');
		expect(drawerIn(html)).toBe("");
		expect(html).not.toContain("wc-filter-open");
		expect(html).toContain(
			'<div class="wc-filter-pop"><button type="button" class="wc-filter-pop-button" id="wc-filter-shop-2-button" popovertarget="wc-filter-shop-2-panel"><span>Category</span> <span class="wc-filter-badge">2</span><span class="wc-visually-hidden"> chosen</span></button><div class="wc-filter-pop-panel" id="wc-filter-shop-2-panel" popover><fieldset class="wc-filter-control" id="wc-filter-shop-2-control" data-wc-control="checkboxes">',
		);
		expect(html).toContain(
			'<button type="button" class="wc-filter-pop-button" id="wc-filter-shop-4-button" popovertarget="wc-filter-shop-4-panel"><span>Vegan only</span></button>',
		);
		// In On submit mode each dropdown applies its choices with its own button.
		const panel =
			/<div class="wc-filter-pop-panel" id="wc-filter-shop-2-panel" popover>[\s\S]*?<\/fieldset>(.*?)<\/div>/.exec(
				html,
			);
		expect(panel?.[1]).toBe('<button class="wc-filter-apply" type="submit">Apply</button>');
		// The search box and the sort menu stay in the bar itself.
		expect(html).not.toContain('popovertarget="wc-filter-shop-1-panel"');
		expect(html).not.toContain('popovertarget="wc-filter-shop-7-panel"');
		expect(
			optionsIn(html, "category")
				.filter((option) => option.checked)
				.map((option) => option.value),
		).toEqual(["bread", "pastries"]);
	});

	test("the drawer preset keeps the drawer at every width", async () => {
		await publishFilter(shop, { layout: "drawer", phone: "drawer", mode: "live" });
		const { html } = await visit(shop, "/shop");

		expect(formTag(html)).toContain('data-wc-layout="drawer" data-wc-phone="drawer"');
		expect(drawerIn(html)).toContain('data-wc-control="checkboxes"');
		expect(html).not.toContain("wc-filter-pop");
	});
});
