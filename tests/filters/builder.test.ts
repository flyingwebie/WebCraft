// What the Filter builder screen reads (GLOSSARY.md › Filter): where a Filter is placed (to open it in
// the visual builder), what its controls can use from its Loop's Post Types, and its live preview: the
// Draft as Staff are changing it, rendered by the Site's own renderer with the Loop's published Entries
// and real counts, in the Site's Design system. Previewing saves nothing; Members never reach it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { buildShop, listed, optionsIn, type Shop } from "./shop.ts";

let install: TestInstall;
let shop: Shop;
let owner: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-05-01T09:00:00Z") });
	shop = await buildShop(install);
	owner = (await install.createMember({ workspaceId: shop.workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

/** The Loop's items a preview lists: the canvas tags every element so the builder can find it. */
const listedIn = (html: string) => listed(html.replaceAll(/ data-wc-code="[^"]*"/g, ""));

describe("a Filter as the builder reads it", () => {
	test("says where it is placed, to open each place in the visual builder", async () => {
		const { usage } = await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId });

		expect(usage).toEqual({
			usedIn: [{ kind: "archiveTemplate", id: shop.templateId, name: "Products", postTypeId: shop.productsId }],
		});
		const { filters } = await shop.staff.api.filters.list({ siteId: shop.siteId });
		expect(filters.find((filter) => filter.id === shop.filterId)?.usage.usedIn).toHaveLength(1);
	});

	test("says what its controls can use from its Loop's Post Types", async () => {
		const { sources } = await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId });

		expect(sources).toEqual({
			options: [
				{ field: "category", label: "Category", type: "select" },
				{ field: "baker", label: "Baker", type: "relationship" },
			],
			toggles: [{ field: "vegan", label: "Vegan" }],
			ranges: [
				{ field: "price", label: "Price", kind: "number" },
				{ field: "baked", label: "First baked", kind: "date" },
			],
			sorts: [
				{ by: "title", label: null },
				{ by: "createdAt", label: null },
				{ by: "updatedAt", label: null },
				{ by: "publishedAt", label: null },
				{ by: "lastPublishedAt", label: null },
				{ by: "vegan", label: "Vegan" },
				{ by: "price", label: "Price" },
				{ by: "baked", label: "First baked" },
			],
		});
	});
});

describe("the live preview", () => {
	test("renders the Draft as given where it is placed, with the Loop's published Entries and real counts", async () => {
		const { filter } = await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId });
		const preview = await shop.staff.api.filters.preview({
			siteId: shop.siteId,
			filterId: shop.filterId,
			mode: "submit",
			layout: "topbar",
			controls: filter.draft.controls.filter((control) => control.type !== "chips"),
			query: "category=bread&sort=price-asc",
		});

		// The Archive template's own markup, around the Filter's form.
		expect(preview.html).toMatch(/<aside data-wc-code="b#[^"]+"><form class="wc-filter" id="wc-filter-shop"/);
		expect(preview.html).toContain('data-wc-mode="submit" data-wc-layout="topbar"');
		expect(preview.html).not.toContain('data-wc-control="chips"');
		expect(optionsIn(preview.html, "category")).toEqual([
			{ value: "bread", label: "Bread", count: 3, checked: true, disabled: false },
			{ value: "pastries", label: "Pastries", count: 3, checked: false, disabled: false },
			{ value: "cakes", label: "Cakes", count: 1, checked: false, disabled: false },
			{ value: "gluten-free", label: "Gluten-free", count: 0, checked: false, disabled: true },
		]);
		expect(listedIn(preview.html)).toEqual(["Rosemary focaccia", "Country sourdough", "Rye & caraway"]);
		expect(preview.url).toBe("/shop?category=bread&sort=price-asc");
		expect(preview.count).toBe("3 products");
		// The Site's Design system styles it, its Filter presets included, at the phone breakpoint.
		expect(preview.css).toContain("@layer reset, tokens, base, classes, utilities, custom;");
		expect(preview.css).toContain(".wc-filter-pop-panel");
		expect(preview.phoneWidth).toBe(768);
		expect(preview.language).toEqual({ code: "en", direction: "ltr" });

		// Nothing was saved.
		const after = await shop.staff.api.filters.get({ siteId: shop.siteId, filterId: shop.filterId });
		expect(after.filter.draft).toEqual(filter.draft);
	});

	test("a Filter placed nowhere previews beside its Loop's items", async () => {
		const { loop } = await shop.staff.api.loops.create({
			siteId: shop.siteId,
			name: "cheap",
			source: "query",
			query: { postTypes: ["products"], sort: [{ by: "price", direction: "asc" }], limit: 3 },
		});
		await shop.staff.api.loops.publish({ siteId: shop.siteId, loopId: loop.id });
		const { filter } = await shop.staff.api.filters.create({
			siteId: shop.siteId,
			name: "cheap",
			loop: "cheap",
			controls: [{ type: "toggle", key: "vegan", label: "Vegan only", field: "vegan" }],
		});
		const preview = await shop.staff.api.filters.preview({
			siteId: shop.siteId,
			filterId: filter.id,
			query: "vegan=1",
		});

		expect(preview.html).toContain('<form class="wc-filter" id="wc-filter-cheap"');
		expect(preview.html).toContain('name="vegan" value="1" checked>');
		expect(listedIn(preview.html)).toEqual(["Cinnamon bun", "Rosemary focaccia"]);
		expect(preview.url).toBe("/?vegan=1");
	});

	test("refuses what saving refuses, every problem where it is", async () => {
		await expect(
			shop.staff.api.filters.preview({
				siteId: shop.siteId,
				filterId: shop.filterId,
				layout: "grid",
				controls: [{ type: "toggle", key: "vegan", label: "Vegan", field: "price" }],
			}),
		).rejects.toMatchObject({
			code: "FILTER_INVALID",
			data: { problems: [{ at: "layout" }, { at: "controls[0].field" }] },
		});
	});

	test("Members can't preview a Filter: it is Structure", async () => {
		await expect(owner.api.filters.preview({ siteId: shop.siteId, filterId: shop.filterId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("a Filter still placed in a Template's published tree, but removed from its Draft, previews beside its Loop's items", async () => {
		// Staff redesigned the Products page and haven't republished: the Archive template's Draft no
		// longer places the Filter, though it still does in the published tree the preview must not use.
		await shop.staff.api.templates.saveArchiveTemplateMarkup({
			siteId: shop.siteId,
			postTypeId: shop.productsId,
			markup:
				"<ul>{{@loop products as p}}<li>{{ p.title }}</li>{{@empty}}<li>None</li>{{/loop}}</ul>{{@pagination products}}",
		});

		const preview = await shop.staff.api.filters.preview({ siteId: shop.siteId, filterId: shop.filterId });

		expect(preview.html).toContain('<form class="wc-filter" id="wc-filter-shop"');
		expect(preview.url).toBe("/");
		expect(preview.count).toBe("7 products");
	});
});
