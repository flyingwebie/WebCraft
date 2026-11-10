// What a Filter's script swaps in place (GLOSSARY.md › Filter): `/_wc/filter/<page path>?<choices>`
// answers the page at that path with those choices, as visitors (or the Staging address, or Edit mode)
// would get it, as JSON: its normal address, its title, each Filter's form and each region of its
// filtered Loops, rendered and escaped by the server. The script itself is a file on the Site's domain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";
import { stagingVisitor } from "../harness/staging.ts";
import { buildShop, type Shop } from "./shop.ts";

let install: TestInstall;
let shop: Shop;

beforeAll(async () => {
	install = await createTestInstall();
	shop = await buildShop(install);
});

afterAll(async () => {
	await install.close();
});

type Fragments = {
	url: string;
	title: string;
	filters: { id: string; html: string }[];
	regions: { name: string; html: string }[];
};

const get = (path: string, origin = shop.origin) =>
	install.request(new Request(`${origin}${path}`, { redirect: "manual" }));

describe("the page's regions", () => {
	test("a filtered Loop's items and its pagination are marked as regions; its page links swap in place", async () => {
		const html = await expectSafePage(await get("/shop?category=bread,pastries"));

		expect(html).toContain("<ul><!--wc-region loop products 1--><li>Butter croissant</li>");
		expect(html).toContain("<li>Pain au chocolat</li><!--/wc-region loop products 1--></ul>");
		expect(html).toMatch(/<!--wc-region pagination products 1--><nav class="wc-pagination"/);
		expect(html).toContain('<a data-wc-filter-link href="/shop?category=bread,pastries&amp;page=2"');
	});
});

describe("the fragments", () => {
	test("answer the page's Filters and regions as JSON, never kept and never indexed", async () => {
		const response = await get("/_wc/filter/shop?category=bread");
		expectSiteHeaders(response);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		const parts = (await response.json()) as Fragments;
		expect(parts.url).toBe("/shop?category=bread");
		expect(parts.title).toBe("Products · Acme Bakery");
		expect(parts.filters.map((filter) => filter.id)).toEqual(["wc-filter-shop"]);
		expect(parts.filters[0]?.html).toStartWith(
			'<form class="wc-filter" id="wc-filter-shop" method="get" action="/shop"',
		);
		expect(parts.filters[0]?.html).toContain('data-wc-announce="3 products"');
		expect(parts.filters[0]?.html).toEndWith("</form>");
		expect(parts.regions).toEqual([
			{
				name: "loop products 1",
				html: "<li>Country sourdough</li><li>Rosemary focaccia</li><li>Rye &amp; caraway</li>",
			},
			{ name: "pagination products 1", html: "" },
		]);
	});

	test("a plain form's fields are read as the page reads them: the answer says the normal address", async () => {
		const parts = (await (
			await get("/_wc/filter/shop?q=&category=pastries&category=bread&vegan=1&price.min=&price.max=4&sort=")
		).json()) as Fragments;

		expect(parts.url).toBe("/shop?category=bread,pastries&price=-4&vegan=1");
		expect(parts.regions[0]?.html).toBe("<li>Cinnamon bun</li>");
		expect(parts.filters[0]?.html).toContain('name="price.max" value="4"');
	});

	test("a path with no page, or none on this Site, is a plain 404", async () => {
		expect((await get("/_wc/filter/nothing-here")).status).toBe(404);
		expect((await get("/_wc/filter")).status).toBe(404);
		// Another Site's domain answers for its own pages only.
		const other = await buildShop(install, "other");
		await other.staff.api.templates.saveArchiveTemplateMarkup({
			siteId: other.siteId,
			postTypeId: other.productsId,
			markup: "<p>No filter here</p>",
		});
		await other.staff.api.templates.publish({ siteId: other.siteId, templateId: other.templateId });
		const parts = (await (await get("/_wc/filter/shop?category=bread", other.origin)).json()) as Fragments;
		expect(parts.filters).toEqual([]);
		expect(parts.regions).toEqual([]);
	});

	test("the Staging address answers them only to the people reviewing it", async () => {
		const visitor = stagingVisitor(install, "bakery");
		const response = await visitor.page("/_wc/filter/shop?category=bread");

		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain("Country sourdough");
	});

	test("in Edit mode they are the page as Edit mode shows it", async () => {
		const edit = await openEditMode(install, shop.staff, shop.siteId, "/shop");
		const response = await edit.browser.request(`${new URL(shop.origin).origin}/_wc/filter/shop?category=cakes`);

		expect(response.status).toBe(200);
		const parts = (await response.json()) as Fragments;
		// With Edit mode's marks around the Loop and its items, so the editing bar finds them again.
		const html = parts.regions[0]?.html ?? "";
		expect(html.replace(/<!--[^>]*-->/g, "")).toBe("<li>Birthday cake</li>");
		expect(html).toMatch(/^<!--wc-loop [^>]+ query products--><!--wc-item entry%3A[^>]+--><li>/);
	});
});

describe("the Filter script", () => {
	test("is a file on the Site's domain, kept for a year, linked only from pages showing a Filter", async () => {
		const html = await (await get("/shop")).text();
		const src = /<script src="(\/_wc\/js\/[0-9a-f]{16}\.js)" defer><\/script>/.exec(html)?.[1] ?? "";
		const response = await get(src);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		const script = await response.text();
		expect(script).toContain('"/_wc/filter"');
		expect(script).toContain("history.pushState");
		expect(script).toContain('setAttribute("aria-live", "polite")');
		expect(script).not.toContain("innerHTML = location");
		// A page without a Filter loads no script of WebCraft's.
		await shop.staff.api.templates.saveArchiveTemplateMarkup({
			siteId: shop.siteId,
			postTypeId: shop.productsId,
			markup: "{{@loop products as p}}<p>{{ p.title }}</p>{{/loop}}",
		});
		await shop.staff.api.templates.publish({ siteId: shop.siteId, templateId: shop.templateId });
		expect(await (await get("/shop")).text()).not.toContain("<script src=");
	});
});
