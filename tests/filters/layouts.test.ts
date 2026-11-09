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

describe("a control placed on its own", () => {
	let shop: Shop;

	/** The shop's controls with ids that say what they are, as the Filter builder gives them. */
	const named = async () => {
		const { filter } = await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId });
		const ids = ["search", "category", "baker", "vegan", "price", "baked", "sort", "chips", "count"];
		await publishFilter(shop, {
			controls: filter.draft.controls.map((control, index) => ({ ...control, id: ids[index] })),
		});
	};

	/** Publishes the shop's Archive template as `markup`. */
	const archive = async (markup: string) => {
		const { template } = await shop.staff.api.templates.saveArchiveTemplateMarkup({
			siteId: shop.siteId,
			postTypeId: shop.productsId,
			markup,
		});
		await shop.staff.api.templates.publish({ siteId: shop.siteId, templateId: template.id });
	};

	const LOOP = "<ul>{{@loop products as p}}<li>{{ p.title }}</li>{{@empty}}<li>None</li>{{/loop}}</ul>";

	/** The Filter's own form on a page. */
	const formIn = (html: string) => /<form class="wc-filter" id="wc-filter-shop"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";

	beforeAll(async () => {
		shop = await buildShop(install, "parts");
		await named();
	});

	test('{{@filter <name> for="<loop>" control="<id>"}} saves and prints back; it names one of its controls', async () => {
		const markup = `<header>{{@filter shop for="products" control="search"}}</header><aside>{{@filter shop for="products"}}</aside>${LOOP}`;
		const { template, markup: printed } = await shop.staff.api.templates.saveArchiveTemplateMarkup({
			siteId: shop.siteId,
			postTypeId: shop.productsId,
			markup,
		});
		expect(printed.replaceAll(/ data-wc-id="[^"]*"/g, "")).toBe(markup);
		expect(template.draft.nodes[0]).toMatchObject({
			children: [{ type: "filter", filter: shop.filterId, loop: "products", control: "search" }],
		});

		await expect(
			shop.staff.api.templates.saveArchiveTemplateMarkup({
				siteId: shop.siteId,
				postTypeId: shop.productsId,
				markup: `{{@filter shop for="products" control="colour"}}${LOOP}`,
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{
						column: 40,
						message:
							"The Filter shop has no control colour: its controls are search, category, baker, vegan, price, baked, sort, chips, count.",
					},
				],
			},
		});
	});

	test("beside the Filter's form, it belongs to that form, which leaves it out", async () => {
		await archive(
			`<header>{{@filter shop for="products" control="search"}}</header><aside>{{@filter shop for="products"}}</aside><div>{{@filter shop for="products" control="count"}}</div>${LOOP}`,
		);
		const { html } = await visit(shop, "/shop?q=bun");

		expect(html).toContain(
			'<header><div class="wc-filter-part" id="wc-filter-shop-1-part" data-wc-filter="shop"><div class="wc-filter-control" id="wc-filter-shop-1-control" data-wc-control="search"><label for="wc-filter-shop-1">Search the shop</label><input type="search" id="wc-filter-shop-1" name="q" form="wc-filter-shop" value="bun" placeholder="Search the shop" maxlength="200" enterkeyhint="search"></div><!--/wc-filter-part--></div></header>',
		);
		expect(html).toContain(
			'<div><div class="wc-filter-part" id="wc-filter-shop-9-part" data-wc-filter="shop"><p class="wc-filter-count" id="wc-filter-shop-9-control" data-wc-control="count">1 product</p><!--/wc-filter-part--></div></div>',
		);
		const form = formIn(html);
		expect(form).toContain('data-wc-control="checkboxes"');
		expect(form).not.toContain('data-wc-control="search"');
		expect(form).not.toContain('data-wc-control="count"');
		expect(listed(html)).toEqual(["Cinnamon bun"]);
	});

	test("without the Filter's form, it is a form of its own sending the page's other choices on", async () => {
		await archive(`<header>{{@filter shop for="products" control="search"}}</header>${LOOP}`);
		const { html } = await visit(shop, "/shop?category=bread");

		const own = /<form class="wc-filter" id="wc-filter-shop-1-part"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
		expect(own).toStartWith(
			'<form class="wc-filter" id="wc-filter-shop-1-part" method="get" action="/shop" aria-label="Filters" data-wc-filter="shop" data-wc-mode="live" data-wc-layout="sidebar" data-wc-phone="drawer" data-wc-announce="3 products"><input type="hidden" name="category" value="bread"><div class="wc-filter-control" id="wc-filter-shop-1-control" data-wc-control="search">',
		);
		expect(own).toContain('<input type="search" id="wc-filter-shop-1" name="q" placeholder=');
		expect(own).toEndWith('<button class="wc-filter-apply" type="submit">Apply</button></form>');
		expect(listed(html)).toEqual(["Country sourdough", "Rosemary focaccia", "Rye & caraway"]);
	});

	test("the Filter script swaps it with the Filter's form", async () => {
		await archive(
			`<header>{{@filter shop for="products" control="search"}}</header><aside>{{@filter shop for="products"}}</aside>${LOOP}`,
		);
		const response = await install.request(new Request(`${shop.origin}/_wc/filter/shop?q=bun`));
		const parts = (await response.json()) as { filters: { id: string; html: string }[] };

		expect(parts.filters.map((part) => part.id)).toEqual(["wc-filter-shop-1-part", "wc-filter-shop"]);
		expect(parts.filters[0]?.html).toStartWith('<div class="wc-filter-part" id="wc-filter-shop-1-part"');
		expect(parts.filters[0]?.html).toEndWith("<!--/wc-filter-part--></div>");
		expect(parts.filters[0]?.html).toContain('value="bun"');
	});
});
