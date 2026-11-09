// Filters on a Site's pages, as visitors use them (GLOSSARY.md › Filter): a plain GET form beside its
// query Loop. What visitors choose lives in the page's address, read through an allow-list: options
// inside a control match any (OR), controls combine (AND), each control's counts ignore its own
// choice, and a filtered page is never indexed, its canonical URL the page without its choices.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, fromAddress, type TestInstall } from "../harness/index.ts";
import { canonicalIn, metaName } from "../harness/seo.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { buildShop, listed, optionsIn, type Shop } from "./shop.ts";

let install: TestInstall;
let shop: Shop;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-05-01T09:00:00Z") });
	shop = await buildShop(install);
});

afterAll(async () => {
	await install.close();
});

let visitors = 0;

/** A page of the shop as a visitor of their own gets it (each address may search 30 times a minute). */
async function visit(path: string): Promise<{ response: Response; html: string }> {
	const request = fromAddress(
		new Request(`${shop.origin}${path}`, { redirect: "manual" }),
		`198.51.100.${++visitors % 250}`,
	);
	const response = await install.request(request);
	const html = response.status === 200 ? await expectSafePage(response) : await response.text();
	return { response, html };
}

describe("the Filter on the page", () => {
	test("is a plain GET form to the page itself, labelled, with an Apply button and its script as a file", async () => {
		const { response, html } = await visit("/shop");

		expect(response.status).toBe(200);
		expect(html).toContain(
			'<form class="wc-filter" id="wc-filter-shop" method="get" action="/shop" aria-label="Filters" data-wc-filter="shop" data-wc-mode="live" data-wc-announce="7 products">',
		);
		expect(html).toContain(
			'<label for="wc-filter-shop-1">Search the shop</label><input type="search" id="wc-filter-shop-1" name="q" placeholder="Search the shop" maxlength="200" enterkeyhint="search">',
		);
		expect(html).toContain(
			'<fieldset class="wc-filter-control" data-wc-control="checkboxes"><legend>Category</legend>',
		);
		expect(html).toContain('<input type="checkbox" role="switch" id="wc-filter-shop-4" name="vegan" value="1">');
		expect(html).toContain('<legend>Price</legend><label for="wc-filter-shop-5-min">From</label><input type="number"');
		expect(html).toContain('name="baked.min"');
		expect(html).toContain('<button class="wc-filter-apply" type="submit">Apply</button>');
		expect(html).toContain('<p class="wc-filter-count" data-wc-control="count">7 products</p>');
		expect(html).toMatch(/<script src="\/_wc\/js\/[0-9a-f]{16}\.js" defer><\/script>/);
		expect(listed(html)).toEqual(["Birthday cake", "Butter croissant", "Cinnamon bun", "Country sourdough"]);
	});

	test("lists each option with how many items it would list; one nothing matches is disabled", async () => {
		const { html } = await visit("/shop");

		expect(optionsIn(html, "category")).toEqual([
			{ value: "bread", label: "Bread", count: 3, checked: false, disabled: false },
			{ value: "pastries", label: "Pastries", count: 3, checked: false, disabled: false },
			{ value: "cakes", label: "Cakes", count: 1, checked: false, disabled: false },
			{ value: "gluten-free", label: "Gluten-free", count: 0, checked: false, disabled: true },
		]);
		// A Relationship's options are the Entries it may point at, by their slugs.
		expect(optionsIn(html, "baker")).toEqual([
			{ value: "", label: "All", count: null, checked: true, disabled: false },
			{ value: "ada", label: "Ada", count: 3, checked: false, disabled: false },
			{ value: "bruno", label: "Bruno", count: 3, checked: false, disabled: false },
		]);
	});
});

describe("choosing", () => {
	test("an option narrows the Loop; several in one control match any of them", async () => {
		expect(listed((await visit("/shop?category=bread")).html)).toEqual([
			"Country sourdough",
			"Rosemary focaccia",
			"Rye & caraway",
		]);
		const both = await visit("/shop?category=bread,pastries");
		expect(listed(both.html)).toEqual(["Butter croissant", "Cinnamon bun", "Country sourdough", "Pain au chocolat"]);
		expect(both.html).toContain('<p class="wc-filter-count" data-wc-control="count">6 products</p>');
		expect(
			optionsIn(both.html, "category")
				.filter((option) => option.checked)
				.map((option) => option.value),
		).toEqual(["bread", "pastries"]);
	});

	test("controls combine: every one must match", async () => {
		const { html } = await visit("/shop?category=bread,pastries&vegan=1");

		expect(listed(html)).toEqual(["Cinnamon bun", "Rosemary focaccia"]);
		expect(html).toContain('name="vegan" value="1" checked>');
	});

	test("each control's counts ignore its own choice, and follow the others'", async () => {
		const { html } = await visit("/shop?category=bread&vegan=1");

		expect(optionsIn(html, "category").map(({ value, count, disabled }) => ({ value, count, disabled }))).toEqual([
			{ value: "bread", count: 1, disabled: false },
			{ value: "pastries", count: 1, disabled: false },
			{ value: "cakes", count: 0, disabled: true },
			{ value: "gluten-free", count: 0, disabled: true },
		]);
		expect(optionsIn(html, "baker").map(({ value, count }) => ({ value, count }))).toEqual([
			{ value: "", count: null },
			{ value: "ada", count: 1 },
			{ value: "bruno", count: 0 },
		]);
		expect(html).toContain("1 product</p>");
	});

	test("a Relationship's option keeps the items pointing at that Entry", async () => {
		const { html } = await visit("/shop?baker=ada");

		expect(listed(html)).toEqual(["Country sourdough", "Pain au chocolat", "Rosemary focaccia"]);
		expect(optionsIn(html, "baker").find((option) => option.checked)?.value).toBe("ada");
	});

	test("a range keeps the numbers or days within it, both ends included, either end left open", async () => {
		expect(listed((await visit("/shop?price=3.2-6.5")).html)).toEqual([
			"Cinnamon bun",
			"Country sourdough",
			"Pain au chocolat",
			"Rosemary focaccia",
		]);
		expect(listed((await visit("/shop?price=20-")).html)).toEqual(["Birthday cake"]);
		expect(listed((await visit("/shop?price=-3")).html)).toEqual(["Butter croissant"]);
		expect(listed((await visit("/shop?baked=2026-02-01..2026-02-15")).html)).toEqual([
			"Rosemary focaccia",
			"Rye & caraway",
		]);
		const { html } = await visit("/shop?price=3.2-6.5");
		expect(html).toContain('name="price.min" value="3.2" step="any"');
		expect(html).toContain('name="price.max" value="6.5" step="any"');
	});

	test("a sort replaces the Loop's own order", async () => {
		expect(listed((await visit("/shop?sort=price-asc")).html)).toEqual([
			"Butter croissant",
			"Pain au chocolat",
			"Cinnamon bun",
			"Rosemary focaccia",
		]);
		expect(listed((await visit("/shop?sort=price-desc&category=bread")).html)).toEqual([
			"Rye & caraway",
			"Country sourdough",
			"Rosemary focaccia",
		]);
	});

	test("the search box searches Site search's index within the Loop, and narrows the counts", async () => {
		const { response, html } = await visit("/shop?q=chocolat");

		expect(listed(html)).toEqual(["Pain au chocolat"]);
		expect(html).toContain('name="q" value="chocolat"');
		expect(optionsIn(html, "category").map(({ value, count }) => [value, count])).toEqual([
			["bread", 0],
			["pastries", 1],
			["cakes", 0],
			["gluten-free", 0],
		]);
		// One visitor's search: never kept, never indexed.
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, follow");
	});

	test("nothing matches: the Loop shows what it shows when empty, the count its no-results words", async () => {
		const { html } = await visit("/shop?category=cakes&vegan=1");

		expect(listed(html)).toEqual(["None"]);
		expect(html).toContain('<p class="wc-filter-count" data-wc-control="count">No products match</p>');
		expect(html).toContain('data-wc-announce="No products match"');
	});
});

describe("chips and Reset", () => {
	test("each choice is a chip linking to the page without it; Reset links to the page without them all", async () => {
		const { html } = await visit("/shop?category=bread,pastries&vegan=1");
		const chips = [
			...html.matchAll(
				/<a class="wc-filter-chip" id="[^"]*" href="([^"]*)" aria-label="([^"]*)" data-wc-filter-link>([^<]*)</g,
			),
		].map(([, href, name, label]) => ({ href: href?.replaceAll("&amp;", "&"), name, label }));

		expect(chips).toEqual([
			{ href: "/shop?category=pastries&vegan=1", name: "Remove Bread", label: "Bread" },
			{ href: "/shop?category=bread&vegan=1", name: "Remove Pastries", label: "Pastries" },
			{ href: "/shop?category=bread,pastries", name: "Remove Vegan only", label: "Vegan only" },
		]);
		expect(html).toContain(
			'<a class="wc-filter-reset" id="wc-filter-shop-8-reset" href="/shop" data-wc-filter-link>Reset</a>',
		);
		expect(html).toContain('role="group" aria-label="Active filters"');
	});

	test("without choices there are no chips", async () => {
		const { html } = await visit("/shop");

		expect(html).toContain('<div class="wc-filter-chips" data-wc-control="chips"></div>');
	});
});

describe("the page's address", () => {
	test("keys and values the Filter doesn't allow are dropped and never shown back", async () => {
		const attack = encodeURIComponent('"><script>alert(1)</script>');
		const { response } = await visit(`/shop?category=bread,${attack}&vegan=yes&colour=red`);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/shop?category=bread");
		expect(response.headers.get("cache-control")).toBe("no-store");
		// A key the page doesn't know is left alone, never shown back.
		const unknown = await visit(`/shop?colour=${attack}`);
		expect(unknown.response.status).toBe(200);
		expect(unknown.html).not.toContain("colour");
		expect(unknown.html).not.toContain("alert(1)");
		expect(listed(unknown.html)).toHaveLength(4);
	});

	test("a plain form's fields go on to their normal address", async () => {
		const sent =
			"/shop?q=&category=pastries&category=bread&baker=&vegan=1&price.min=2&price.max=&baked.min=&baked.max=&sort=";
		const { response } = await visit(sent);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/shop?category=bread,pastries&price=2-&vegan=1");
		const { response: dates } = await visit("/shop?baked.min=2026-03-31&baked.max=2026-03-01");
		expect(dates.headers.get("location")).toBe("/shop?baked=2026-03-01..2026-03-31");
	});

	test("the search box's text is cleaned and cut as Site search reads it", async () => {
		const { response } = await visit(`/shop?q=${encodeURIComponent("  rye\u0000  cake ")}`);

		expect(response.headers.get("location")).toBe("/shop?q=rye+cake");
	});

	test("pages of the filtered Loop keep its choices; its first page is the page itself", async () => {
		const first = await visit("/shop?category=bread,pastries");
		expect(first.html).toContain('href="/shop?category=bread,pastries&amp;page=2"');
		const second = await visit("/shop?category=bread,pastries&page=2");
		expect(listed(second.html)).toEqual(["Rosemary focaccia", "Rye & caraway"]);
		expect(second.html).toContain('href="/shop?category=bread,pastries" aria-label="Page 1"');
		const back = await visit("/shop?category=bread,pastries&page=1");
		expect(back.response.status).toBe(301);
		expect(back.response.headers.get("location")).toBe("/shop?category=bread,pastries");
		expect((await visit("/shop?category=bread,pastries&page=3")).response.status).toBe(404);
	});
});

describe("search engines", () => {
	test("a filtered or sorted page is noindex, follow, its canonical URL the page without its choices", async () => {
		for (const path of ["/shop?category=bread", "/shop?sort=price-asc", "/shop?category=bread,pastries&page=2"]) {
			const { response, html } = await visit(path);
			expect(metaName(html, "robots"), path).toBe("noindex, follow");
			expect(canonicalIn(html), path).toBe(`${shop.origin}/shop`);
			expect(response.headers.get("x-robots-tag"), path).toBe("noindex, follow");
		}
	});

	test("the page without choices, and its own pages, stay indexable with their own canonical URLs", async () => {
		const plain = await visit("/shop");
		expect(metaName(plain.html, "robots")).toBeUndefined();
		expect(canonicalIn(plain.html)).toBe(`${shop.origin}/shop`);
		const second = await visit("/shop?page=2");
		expect(metaName(second.html, "robots")).toBeUndefined();
		expect(canonicalIn(second.html)).toBe(`${shop.origin}/shop?page=2`);
		expect(second.response.headers.get("x-robots-tag")).toBeNull();
	});
});
