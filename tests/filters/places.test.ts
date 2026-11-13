// Filters wherever pages show them (GLOSSARY.md › Filter): two Filters sharing a page keep their
// keys apart with their names, keys are the same in every language while values are option slugs in
// the page's language, the Staging address shows Filters' Drafts, and Edit mode filters as visitors do.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { openStaging } from "../harness/staging.ts";
import { buildShop, listed, optionsIn, SHOP_MARKUP, type Shop } from "./shop.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

const get = (shop: Shop, path: string) => install.request(new Request(`${shop.origin}${path}`, { redirect: "manual" }));

describe("two Filters on one page", () => {
	let shop: Shop;

	beforeAll(async () => {
		shop = await buildShop(install, "two");
		const { siteId, staff } = shop;
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "team",
			source: "query",
			query: { postTypes: ["bakers"], sort: [{ by: "title", direction: "asc" }] },
		});
		await staff.api.loops.publish({ siteId, loopId: loop.id });
		const { filter } = await staff.api.filters.create({
			siteId,
			name: "team",
			loop: "team",
			controls: [
				{
					type: "sort",
					key: "sort",
					options: [{ value: "name-desc", label: "Name, Z to A", by: "title", direction: "desc" }],
				},
			],
		});
		await staff.api.filters.publish({ siteId, filterId: filter.id });
		const { template } = await staff.api.templates.saveArchiveTemplateMarkup({
			siteId,
			postTypeId: shop.productsId,
			markup: `${SHOP_MARKUP}<section>{{@filter team for="team"}}<ol>{{@loop team as b}}<li>{{ b.title }}</li>{{/loop}}</ol></section>`,
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
	});

	test("each Filter's keys start with its name", async () => {
		const html = await expectSafePage(await get(shop, "/shop?shop.category=bread&team.sort=name-desc"));

		expect(listed(html)).toEqual(["Country sourdough", "Rosemary focaccia", "Rye & caraway"]);
		expect([...html.matchAll(/<ol>(.*?)<\/ol>/g)][0]?.[1]).toContain("<li>Bruno</li><li>Ada</li>");
		expect(optionsIn(html, "shop.category").find((option) => option.checked)?.value).toBe("bread");
		expect(html).toContain('name="shop.q"');
		expect(html).toContain('<select id="wc-filter-team-1" name="team.sort">');
	});

	test("each Filter's form sends the other's choices on, and its chips keep them", async () => {
		const html = await get(shop, "/shop?shop.category=bread&team.sort=name-desc").then((response) => response.text());

		expect(html).toContain('<input type="hidden" name="team.sort" value="name-desc">');
		expect(html).toContain('<input type="hidden" name="shop.category" value="bread">');
		expect(html).toContain('href="/shop?team.sort=name-desc" aria-label="Remove Bread"');
		expect(html).toContain('href="/shop?team.sort=name-desc" data-wc-filter-link>Reset</a>');
	});

	test("a key without its Filter's name is unknown there", async () => {
		const response = await get(shop, "/shop?category=bread");

		expect(response.status).toBe(200);
		expect(listed(await response.text())).toHaveLength(4);
	});
});

describe("languages", () => {
	let shop: Shop;

	beforeAll(async () => {
		shop = await buildShop(install, "langs");
		const { siteId, staff } = shop;
		await staff.api.languages.add({ siteId, code: "fr" });
		const ada = shop.bakers.get("Ada") ?? "";
		await staff.api.entries.saveDraft({ siteId, entryId: ada, language: "fr", slug: "ada-la-boulangere" });
		await staff.api.entries.publish({ siteId, entryId: ada });
	});

	test("keys are the same in every language; words and option slugs are the page's language's", async () => {
		const response = await get(shop, "/fr/shop?category=bread&baker=ada-la-boulangere");
		const html = await expectSafePage(response);

		expect(listed(html)).toEqual(["Country sourdough", "Rosemary focaccia"]);
		expect(html).toContain("<legend>Catégorie</legend>");
		expect(html).toContain(
			'<p class="wc-filter-count" id="wc-filter-shop-9-control" data-wc-control="count">2 produits</p>',
		);
		expect(html).toContain('aria-label="Filtres"');
		expect(html).toContain('<button class="wc-filter-apply" type="submit">Appliquer</button>');
		expect(html).toContain('action="/fr/shop"');
		expect(optionsIn(html, "baker").map((option) => option.value)).toEqual(["", "ada-la-boulangere", "bruno"]);
	});

	test("another language's slug is no option here", async () => {
		const response = await get(shop, "/fr/shop?baker=ada");

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/fr/shop");
	});
});

describe("the Staging address and Edit mode", () => {
	let shop: Shop;

	beforeAll(async () => {
		shop = await buildShop(install, "drafts");
	});

	test("the Staging address shows a Filter's Draft; visitors, what is published", async () => {
		const { siteId, staff, filterId } = shop;
		await staff.api.filters.saveDraft({ siteId, filterId, mode: "submit", applyLabel: "Show results" });
		const staging = await openStaging(install, staff, siteId, "/shop");

		const draft = await (await staging.page("/shop?category=bread")).text();
		expect(draft).toContain('data-wc-mode="submit"');
		expect(draft).toContain(">Show results</button>");
		expect(listed(draft)).toEqual(["Country sourdough", "Rosemary focaccia", "Rye & caraway"]);
		const live = await (await get(shop, "/shop")).text();
		expect(live).toContain('data-wc-mode="live"');
	});

	test("a Filter in the Site template shares each page with the page's own, keys apart", async () => {
		const { siteId, staff } = shop;
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "everything",
			source: "query",
			query: { postTypes: ["products"] },
		});
		await staff.api.loops.publish({ siteId, loopId: loop.id });
		const { filter } = await staff.api.filters.create({
			siteId,
			name: "unseen",
			loop: "everything",
			controls: [{ type: "toggle", key: "vegan", label: "Vegan", field: "vegan" }],
		});
		await staff.api.filters.publish({ siteId, filterId: filter.id });
		const { template } = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				'<main>{{@outlet}}</main><footer>{{@filter unseen for="everything"}}<p>{{ everything.count }} things</p>{{@loop everything as e}}{{/loop}}</footer>',
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const html = await (await get(shop, "/shop?unseen.vegan=1&shop.category=bread")).text();
		expect(html).toContain("<p>2 things</p>");
		expect(listed(html)).toEqual(["Country sourdough", "Rosemary focaccia", "Rye & caraway"]);
	});

	test("Edit mode shows the page's Filters and narrows their Loops as visitors' pages do", async () => {
		const { siteId, staff } = shop;
		const edit = await openEditMode(install, staff, siteId, "/shop");

		const page = await edit.page("/shop?shop.category=pastries");
		const html = await expectSafePage(page, "editMode");
		expect(listed(html)).toEqual(["Butter croissant", "Cinnamon bun", "Pain au chocolat"]);
		expect(html).toMatch(/<script src="\/_wc\/js\/[0-9a-f]{16}\.js" defer><\/script>/);
		const sent = await edit.page("/shop?shop.category=pastries&shop.category=bread");
		expect(sent.status).toBe(302);
		expect(sent.headers.get("location")).toBe("/shop?shop.category=bread,pastries");
	});
});
