// Field values on the page: every Field type renders through the Entry template, escaped for where
// it lands. Paths reach into Groups (`address.city`), across a Repeater's rows (`team.name`), into
// links and selects (`cta.url`, `size.value`) and one level into what a Relationship points at
// (`category.title`, `category.url`), showing only published Entries.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { element, type TestNode, text, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let productsId: string;
let categoriesId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	categoriesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Categories",
			key: "categories",
			urlPattern: "/shop/{slug}",
			fields: [{ key: "blurb", label: "Blurb", type: "text" }],
		})
	).postType.id;
	productsId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Products",
			key: "products",
			urlPattern: "/products/{slug}",
			fields: [
				{ key: "summary", label: "Summary", type: "text" },
				{ key: "intro", label: "Intro", type: "richText" },
				{ key: "price", label: "Price", type: "number" },
				{ key: "vegan", label: "Vegan", type: "boolean" },
				{ key: "bakedOn", label: "Baked on", type: "date" },
				{
					key: "size",
					label: "Size",
					type: "select",
					options: [
						{ value: "sm", label: "Small loaf" },
						{ value: "lg", label: "Large loaf" },
					],
				},
				{
					key: "allergens",
					label: "Allergens",
					type: "select",
					multiple: true,
					options: [
						{ value: "gluten", label: "Gluten" },
						{ value: "nuts", label: "Nuts" },
					],
				},
				{ key: "photo", label: "Photo", type: "media" },
				{ key: "cta", label: "Call to action", type: "link" },
				{ key: "contact", label: "Contact", type: "email" },
				{
					key: "address",
					label: "Address",
					type: "group",
					fields: [
						{ key: "street", label: "Street", type: "text" },
						{ key: "city", label: "City", type: "text" },
					],
				},
				{
					key: "team",
					label: "Team",
					type: "repeater",
					fields: [
						{ key: "name", label: "Name", type: "text" },
						{ key: "since", label: "Since", type: "number" },
					],
				},
				{ key: "category", label: "Category", type: "relationship", postTypes: ["categories"] },
				{ key: "related", label: "Related", type: "relationship", postTypes: ["categories"], multiple: true },
			],
		})
	).postType.id;
});

afterAll(async () => {
	await install.close();
});

let pages = 0;

/** Publishes `nodes` as the Products Entry template, then a published Product with `fields`, and answers its page. */
async function render(nodes: TestNode[], fields: Record<string, unknown>): Promise<string> {
	const { template } = await staff.api.templates.saveEntryTemplate({
		siteId,
		postTypeId: productsId,
		tree: tree(...nodes),
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const slug = `product-${++pages}`;
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: productsId, title: "Loaf", slug, fields });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const html = await (await install.request(`https://bakery.live.test/products/${slug}`)).text();
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
}

async function category(title: string, options: { publish?: boolean; blurb?: string } = {}) {
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: categoriesId,
		title,
		fields: { blurb: options.blurb ?? null },
	});
	if (options.publish ?? true) await editor.api.entries.publish({ siteId, entryId: entry.id });
	return entry.id;
}

describe("each Field type on the page", () => {
	test("text, number, true/false, date, select, link, email and rich text", async () => {
		const main = await render(
			[
				element("p", [value("summary")]),
				element("p", [value("price"), text(" "), value("vegan"), text(" "), value("bakedOn")]),
				element("p", [value("size")], { "data-size": [value("size.value")] }),
				element("p", [value("allergens")]),
				element("a", [value("cta")], { href: [value("cta.url")] }),
				element("a", [value("contact")], { href: [{ type: "text", text: "mailto:" }, value("contact")] }),
				element("div", [value("intro")], { title: [value("intro")] }),
				element("p", [text("["), value("photo"), text("]")]),
			],
			{
				summary: "Crusty <b>& warm</b>",
				price: 4.5,
				vegan: true,
				bakedOn: "2026-03-02",
				size: "lg",
				allergens: ["nuts", "gluten"],
				cta: { url: "https://shop.example/loaf?x=1&y=2", text: "Order now" },
				contact: "orders@bakery.example",
				intro: '<p>Baked <strong>daily</strong> &amp; <a href="/about">fresh</a></p>',
			},
		);

		expect(main).toBe(
			[
				"<p>Crusty &lt;b&gt;&amp; warm&lt;/b&gt;</p>",
				"<p>4.5 true 2026-03-02</p>",
				'<p data-size="lg">Large loaf</p>',
				"<p>Nuts, Gluten</p>",
				'<a href="https://shop.example/loaf?x=1&amp;y=2">Order now</a>',
				'<a href="mailto:orders@bakery.example">orders@bakery.example</a>',
				'<div title="Baked daily &amp; fresh"><p>Baked <strong>daily</strong> &amp; <a href="/about">fresh</a></p></div>',
				"<p>[]</p>",
			].join(""),
		);
	});

	test("empty values render as nothing; a link without text shows its address", async () => {
		const main = await render(
			[
				element("p", [
					text("["),
					value("summary"),
					value("price"),
					value("size"),
					value("allergens"),
					value("intro"),
					text("]"),
				]),
				element("a", [value("cta")], { href: [value("cta.url")] }),
				element("p", [value("vegan")]),
			],
			{ cta: { url: "/contact" } },
		);

		expect(main).toBe('<p>[]</p><a href="/contact">/contact</a><p>false</p>');
	});
});

describe("Groups, Repeaters and Relationships on the page", () => {
	test("a Group's Fields, and a Repeater's Fields across its rows", async () => {
		const main = await render(
			[
				element("p", [value("address.street"), text(", "), value("address.city")]),
				element("p", [value("team.name")]),
				element("p", [text("["), value("address"), value("team"), text("]")]),
			],
			{ address: { street: "1 Quay", city: "Cork" }, team: [{ name: "Ada", since: 2019 }, { name: "Bea" }, {}] },
		);

		expect(main).toBe("<p>1 Quay, Cork</p><p>Ada, Bea</p><p>[]</p>");
	});

	test("what a Relationship points at: its title on its own, its built-in values, url and Fields", async () => {
		const bread = await category("Bread", { blurb: "Loaves & rolls" });
		const rye = await category("Rye");
		const hidden = await category("Not yet published", { publish: false });

		const main = await render(
			[
				element("a", [value("category")], { href: [value("category.url")] }),
				element("p", [value("category.blurb"), text(" / "), value("category.slug")]),
				element("p", [value("related"), text(" | "), value("related.url")]),
			],
			{ category: bread, related: [hidden, rye, bread] },
		);

		expect(main).toBe(
			'<a href="/shop/bread">Bread</a><p>Loaves &amp; rolls / bread</p><p>Rye, Bread | /shop/rye, /shop/bread</p>',
		);
	});

	test("an unpublished Entry pointed at renders as nothing until it is published", async () => {
		const pastry = await category("Pastry", { publish: false });
		const main = await render([element("p", [text("["), value("category"), text("]")])], { category: pastry });
		expect(main).toBe("<p>[]</p>");
	});
});

describe("names a Template may read", () => {
	test("refuses parts that don't exist, and Relationships more than one level deep", async () => {
		await staff.api.postTypes.update({
			siteId,
			postTypeId: categoriesId,
			fields: [
				{ key: "blurb", label: "Blurb", type: "text" },
				{ key: "parent", label: "Parent", type: "relationship", postTypes: ["categories"] },
			],
		});
		for (const path of [
			"address.zip",
			"team.age",
			"cta.target",
			"size.colour",
			"summary.length",
			"category.nope",
			"category.parent",
			"category.parent.title",
			"photo.alt",
			"site.phone",
		]) {
			await expect(
				staff.api.templates.saveEntryTemplate({
					siteId,
					postTypeId: productsId,
					tree: tree(element("p", [value(path)])),
				}),
				path,
			).rejects.toMatchObject({ code: "TEMPLATE_INVALID", data: { problems: [{ at: "nodes[0].children[0].path" }] } });
		}
	});
});

describe("written as Template markup", () => {
	/** Publishes `markup` as the Products Entry template, then a published Product with `fields`, and answers its page. */
	async function renderMarkup(markup: string, fields: Record<string, unknown>): Promise<string> {
		const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: productsId, markup });
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
		const slug = `product-${++pages}`;
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: productsId, title: "Loaf", slug, fields });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		const html = await (await install.request(`https://bakery.live.test/products/${slug}`)).text();
		return /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
	}

	test("paths, formatters (on each of a list's values) and Conditions read Field values", async () => {
		await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
		await editor.api.globals.saveDraft({ siteId, fields: { phone: "01 234 5678" } });
		await editor.api.globals.publish({ siteId });
		const bread = await category("Breads");

		const main = await renderMarkup(
			[
				"<p>{{ price | number: 2 }} · {{ bakedOn | date: long }} · {{ team.since | number }}</p>",
				'<a href="{{ category.url }}">{{ category.title | truncate: 4 }}</a>',
				"<p>{{ address.city }}, {{ site.phone }}</p>",
				"{{@if vegan}}<p>Vegan</p>{{@else}}<p>Not vegan</p>{{/if}}",
				"{{@if allergens}}<p>Contains {{ allergens }}</p>{{/if}}",
				'{{@if size.value == "lg"}}<p>Big</p>{{/if}}',
			].join(""),
			{
				price: 4.5,
				bakedOn: "2026-03-02",
				team: [
					{ name: "Ada", since: 2019 },
					{ name: "Bea", since: 2021 },
				],
				category: bread,
				address: { city: "Cork" },
				vegan: false,
				allergens: [],
				size: "lg",
			},
		);

		expect(main).toBe(
			"<p>4.50 · March 2, 2026 · 2,019, 2,021</p>" +
				'<a href="/shop/breads">Brea…</a>' +
				"<p>Cork, 01 234 5678</p><p>Not vegan</p><p>Big</p>",
		);
	});

	test("a path no Field has is refused with its line and column", async () => {
		const refusal = await staff.api.templates
			.saveEntryTemplateMarkup({ siteId, postTypeId: productsId, markup: "<p>\n  {{ address.zip }}</p>" })
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(refusal).toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [{ line: 2, column: expect.any(Number), message: expect.stringContaining("address.zip") }] },
		});
	});
});
