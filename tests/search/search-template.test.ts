// The Search results template (ADR 0021): Structure Staff write in Template markup (or as a tree)
// and publish; the Site's search results page shows it, the built-in one until then. It renders the
// hits through the built-in Loop `search` (each hit an Entry's values and its `snippet`), reads the
// query as `search.query` and the hit count as `search.total`, and the Globals; no Entry's values.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";
import { element, searchElement, text, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let recipesId: string;
const SITE = "https://bakery.live.test";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	recipesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [
				{ key: "summary", label: "Summary", type: "text" },
				{ key: "minutes", label: "Minutes", type: "number" },
			],
			searchedFields: [
				{ field: "title", weight: "A" },
				{ field: "summary", weight: "B" },
			],
		})
	).postType.id;
	await staff.api.postTypes.create({
		siteId,
		name: "Suppliers",
		key: "suppliers",
		urlPattern: "/suppliers/{slug}",
		fields: [{ key: "phone", label: "Phone", type: "text" }],
		searchable: false,
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: recipesId,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	for (const [title, summary, minutes] of [
		["Brioche", "Rich and buttery", 90],
		["Buttery shortbread", "Three ingredients", 30],
	] as const) {
		const { entry } = await staff.api.entries.create({
			siteId,
			postTypeId: recipesId,
			title,
			fields: { summary, minutes },
		});
		await staff.api.entries.publish({ siteId, entryId: entry.id });
	}
	await staff.api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await staff.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await staff.api.globals.publish({ siteId });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pages = postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "Find a recipe" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setSearchPage({ siteId, pageId: entry.id });
});

afterAll(async () => {
	await install.close();
});

const MARKUP = [
	"<h1>Find a recipe</h1><p>{{ site.tagline }}</p>{{@search}}",
	"{{@if search.query}}<p>{{ search.total }} for {{ search.query }}</p>{{/if}}",
	"<ul>{{@loop search as hit}}<li>",
	'<a href="{{ hit.url }}">{{ hit.title }}</a> <span>{{ hit.minutes }} min</span> <span>{{ hit.snippet }}</span>',
	"</li>{{@empty}}<li>Nothing yet</li>{{/loop}}</ul>{{@pagination search}}",
].join("");

async function results(query: string): Promise<string> {
	const response = await install.request(`${SITE}/find-a-recipe?q=${encodeURIComponent(query)}`);
	expect(response.status).toBe(200);
	return expectSafePage(response);
}

describe("the Search element in Template markup", () => {
	test("takes nothing, and goes where a form can", async () => {
		for (const [markup, message] of [
			["{{@search recipes}}", "{{@search}} takes nothing: write it alone."],
			["<p>{{@search}}</p>", "{{@search}} is a form of its own: it can't go inside <p>."],
			['<a href="/">{{@search}}</a>', "{{@search}} is a form of its own: it can't go inside <a>."],
			["<ul>{{@search}}</ul>", "{{@search}} goes inside an <li>, not directly in a list."],
		] as const) {
			await expect(
				staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: recipesId, markup }),
				markup,
			).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID", data: { problems: [{ message }] } });
		}
	});

	test("a stored tree holding one inside a paragraph is refused where it is", async () => {
		await expect(
			staff.api.templates.saveEntryTemplate({
				siteId,
				postTypeId: recipesId,
				tree: tree(element("p", [searchElement()])),
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ at: "nodes[0].children[0]", message: expect.stringContaining("can't go inside <p>") }] },
		});
	});
});

describe("the Search results template", () => {
	test("until Staff publish one, the search results page shows the built-in one", async () => {
		expect((await staff.api.templates.getSearchTemplate({ siteId })).template).toBeNull();

		expect(await results("brioche")).toContain("<p>1 result for “brioche”</p>");
	});

	test("Staff save it from Template markup, and the page shows it once it is published", async () => {
		const saved = await staff.api.templates.saveSearchTemplateMarkup({ siteId, markup: MARKUP, basedOn: null });
		expect(saved.template).toMatchObject({ kind: "search", postTypeId: null, status: "draft" });
		expect(await results("brioche")).toContain("<p>1 result for “brioche”</p>");

		await staff.api.templates.publish({ siteId, templateId: saved.template.id });

		const html = await results("buttery");
		expect(html).toContain("<h1>Find a recipe</h1><p>Baked daily</p>");
		expect(html).toContain("<p>2 for buttery</p>");
		expect(html).toContain(
			'<li><a href="/recipes/buttery-shortbread">Buttery shortbread</a> <span>30 min</span> <span>Three ingredients</span></li>',
		);
		expect(html).toContain("<span>Rich and <mark>buttery</mark></span>");
		expect(await results("croissant")).toContain("<li>Nothing yet</li>");
	});

	test("its markup reads back as saved, and as a tree", async () => {
		const { markup, template } = await staff.api.templates.getSearchTemplateMarkup({ siteId });
		expect(markup?.published?.replace(/ data-wc-id="[^"]*"/g, "")).toBe(MARKUP);
		expect((await staff.api.templates.getSearchTemplate({ siteId })).template?.id).toBe(template?.id);

		const saved = await staff.api.templates.saveSearchTemplate({
			siteId,
			tree: tree(element("h1", [text("Search: ")]), value("search.query")),
		});
		expect(saved.template.status).toBe("changed");
	});

	test("it reads no Entry's values and holds neither <main> nor {{@outlet}}", async () => {
		for (const [markup, message] of [
			["<h1>{{ title }}</h1>", "title"],
			["<main>{{@search}}</main>", "main"],
			["{{@outlet}}", "outlet"],
			["{{@loop search as hit}}{{ hit.phone }}{{/loop}}", "phone"],
			["{{@loop search as hit}}{{ hit.price }}{{/loop}}", "price"],
		] as const) {
			await expect(staff.api.templates.saveSearchTemplateMarkup({ siteId, markup }), markup).rejects.toMatchObject({
				code: "TEMPLATE_MARKUP_INVALID",
				data: { problems: [{ message: expect.stringContaining(message) }] },
			});
		}
	});

	test("the search Loop and the query belong to it alone", async () => {
		for (const markup of [
			"{{@loop search as hit}}{{ hit.title }}{{/loop}}",
			"{{ search.query }}",
			"{{@pagination search}}",
		]) {
			await expect(
				staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: recipesId, markup }),
				markup,
			).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });
		}
		await expect(
			staff.api.loops.create({ siteId, name: "search", source: "query", query: { postTypes: ["recipes"] } }),
		).rejects.toMatchObject({ code: "LOOP_INVALID" });
	});

	test("Members can't see or change it", async () => {
		await expect(owner.api.templates.getSearchTemplate({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.api.templates.saveSearchTemplateMarkup({ siteId, markup: "<p>Hi</p>" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
