// A Relationship Filter control's options (docs/development.md › Filters): the Entries of every
// Post Type its Field may point at, by title, at most FILTER_LIMITS.options (100). Each target Post
// Type must get its own share of that budget: one Post Type with many Entries must never use up the
// whole budget and leave another target Post Type out of the options entirely.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { openStaging } from "../harness/staging.ts";
import { optionsIn } from "./shop.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

/**
 * Creates `count` Entries of a Post Type, quickly, titled with every other number in `0000`, `0002`,
 * … (`offset: 1` for the odd numbers instead): two Post Types sharing the number line this way, each
 * taking every other one, have their titles interleave once sorted, so the lowest-numbered of each
 * are both near the very front, whichever Post Type a query happens to read Entries of first.
 */
async function manyEntries(
	api: { entries: { create: (input: { siteId: string; postTypeId: string; title: string }) => Promise<unknown> } },
	siteId: string,
	postTypeId: string,
	suffix: string,
	count: number,
	offset: 0 | 1,
	concurrency = 4,
): Promise<void> {
	for (let start = 0; start < count; start += concurrency) {
		const batch = Array.from({ length: Math.min(concurrency, count - start) }, (_, index) => start + index);
		await Promise.all(
			batch.map((index) =>
				api.entries.create({
					siteId,
					postTypeId,
					title: `${String(index * 2 + offset).padStart(4, "0")} ${suffix}`,
				}),
			),
		);
	}
}

test("keeps every target Post Type's Entries among a Relationship control's options, even when the target Post Types together have more Entries than the shared budget the old code used", async () => {
	const workspaceId = (await install.createWorkspace("Makers")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Makers", slug: "makers" })).id;
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;

	const { postType: bakeries } = await staff.api.postTypes.create({
		siteId,
		name: "Bakeries",
		key: "bakeries",
		urlPattern: "/bakeries/{slug}",
	});
	const { postType: workshops } = await staff.api.postTypes.create({
		siteId,
		name: "Workshops",
		key: "workshops",
		urlPattern: "/workshops/{slug}",
	});
	const { postType: products } = await staff.api.postTypes.create({
		siteId,
		name: "Products",
		key: "products",
		urlPattern: "/products/{slug}",
		fields: [{ key: "maker", label: "Maker", type: "relationship", postTypes: ["bakeries", "workshops"] }],
	});

	// Each target Post Type alone has more Entries than `FILTER_LIMITS.options * 5` (500), the
	// shared, unordered budget the old code read all of them with in one query: whichever Post
	// Type that query's scan reached first filled the whole budget by itself, leaving the other
	// with none at all, every time, whichever one that happened to be. Bounding each target Post
	// Type's own query to its own budget (the fix) is what keeps both represented.
	const EACH_COUNT = 510;
	await manyEntries(staff.api, siteId, bakeries.id, "Bakery", EACH_COUNT, 0);
	await manyEntries(staff.api, siteId, workshops.id, "Workshop", EACH_COUNT, 1);

	await staff.api.loops.create({ siteId, name: "products", source: "query", query: { postTypes: ["products"] } });
	await staff.api.filters.create({
		siteId,
		name: "products",
		loop: "products",
		controls: [
			{ type: "checkboxes", key: "maker", label: "Maker", source: { kind: "field", field: "maker" } },
		] as never,
	});
	await staff.api.templates.saveArchiveTemplateMarkup({
		siteId,
		postTypeId: products.id,
		markup:
			'<aside>{{@filter products for="products"}}</aside><ul>{{@loop products as p}}<li>{{ p.title }}</li>{{/loop}}</ul>',
	});

	// The Staging address shows every Draft (ADR 0014), Structure and Content alike, so nothing
	// here needs publishing: only the bug in reading the options is under test.
	const staging = await openStaging(install, staff, siteId, "/products");
	const response = await staging.page("/products");
	expect(response.status).toBe(200);
	const html = await response.text();

	const options = optionsIn(html, "maker");
	// The lowest-numbered title of each Post Type sorts near the very front overall (their numbers
	// interleave), so both survive the final "sorted by title, at most 100" cut once each Post
	// Type's own query reads some of its Entries: this shows whichever one the old code's shared,
	// unordered query happened to starve.
	expect(options.some((option) => option.label === "0000 Bakery")).toBe(true);
	expect(options.some((option) => option.label === "0001 Workshop")).toBe(true);
}, 120000);
