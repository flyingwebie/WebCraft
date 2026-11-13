// Archive templates (GLOSSARY.md): one per Post Type, listing its Entries through its Loops, at its
// URL pattern's fixed address (`/recipes` for `/recipes/{slug}`), in every language. Paginated Loops
// show one page per `?page=N`, each its own page in the page cache; a path is answered by an Archive
// template or a Page, never both.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let recipesId: string;
let pagesId: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-04-01T09:00:00Z") });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	await staff.api.languages.add({ siteId, code: "fr" });
	recipesId = (
		await staff.api.postTypes.create({ siteId, name: "Recipes", key: "recipes", urlPattern: "/recipes/{slug}" })
	).postType.id;
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	pagesId = postTypes.find((postType) => postType.builtIn === "page")?.id ?? "";
	for (const title of ["Crumble", "Brioche", "Apple tart"]) {
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: recipesId, title });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		install.clock.advance(DAY);
	}
	const { template: site } = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><nav>{{@languageSwitcher}}</nav></header><main>{{@outlet}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: site.id });
	const { loop } = await staff.api.loops.create({
		siteId,
		name: "paged-recipes",
		source: "query",
		query: { postTypes: ["recipes"], limit: 2, paginate: true },
	});
	await staff.api.loops.publish({ siteId, loopId: loop.id });
});

afterAll(async () => {
	await install.close();
});

const get = (path: string) => install.request(`https://bakery.live.test${path}`, { redirect: "manual" });

async function mainOf(response: Response): Promise<string> {
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(await response.text())?.[1] ?? "";
}

/** Saves and publishes the Archive template of Recipes as `markup`. */
async function archive(markup: string): Promise<void> {
	const { template } = await staff.api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: recipesId, markup });
	await staff.api.templates.publish({ siteId, templateId: template.id });
}

describe("an Archive template", () => {
	test("answers at its Post Type's address, in every language, inside the Site template", async () => {
		expect((await get("/recipes")).status).toBe(404);
		await archive('<h1>{{ "Recipes" fr: "Recettes" }}</h1>{{@loop paged-recipes as r}}<p>{{ r.title }}</p>{{/loop}}');

		const response = await get("/recipes");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("<title>Recipes · Acme Bakery</title>");
		expect(html).toContain('<link rel="alternate" hreflang="en" href="https://bakery.live.test/recipes">');
		expect(html).toContain('<link rel="alternate" hreflang="fr" href="https://bakery.live.test/fr/recipes">');
		expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://bakery.live.test/recipes">');
		expect(html).toContain('href="/_wc/lang/fr/recipes"');
		expect(await mainOf(await get("/recipes"))).toBe("<h1>Recipes</h1><p>Apple tart</p><p>Brioche</p>");
		expect(await mainOf(await get("/fr/recipes"))).toBe("<h1>Recettes</h1><p>Apple tart</p><p>Brioche</p>");
		// An Entry's own address is unchanged.
		expect((await get("/recipes/brioche")).status).toBe(404);
	});

	test("reads the Globals and Loops, never an Entry's values; holds no <main> and no outlet", async () => {
		const refused = (markup: string) =>
			staff.api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: recipesId, markup });

		await expect(refused("<p>{{ title }}</p>")).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [{ message: expect.stringContaining("There is no value named title") }] },
		});
		await expect(refused("<main>x</main>")).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });
		await expect(refused("{{@outlet}}")).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });
		const { template } = await staff.api.templates.getArchiveTemplateMarkup({ siteId, postTypeId: recipesId });
		expect(template?.kind).toBe("archive");
	});

	test("Pages have none, nor does a Post Type whose URL pattern starts with its slug", async () => {
		await expect(
			staff.api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: pagesId, markup: "<p>x</p>" }),
		).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE", data: { reason: "pages" } });
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Notes",
			key: "notes",
			urlPattern: "/{slug}/note",
		});
		await expect(
			staff.api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: postType.id, markup: "<p>x</p>" }),
		).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE", data: { reason: "address" } });
	});
});

describe("pagination", () => {
	test("each page of a paginated Loop has its own address, links to the others and is cached on its own", async () => {
		await archive("{{@loop paged-recipes as r}}<p>{{ r.title }}</p>{{/loop}}{{@pagination paged-recipes}}");

		const first = await get("/recipes");
		expect(first.headers.get("x-cache")).toBe("MISS");
		expect(await mainOf(first)).toBe(
			"<p>Apple tart</p><p>Brioche</p>" +
				'<nav class="wc-pagination" aria-label="Pages"><ul>' +
				'<li><a href="/recipes" aria-label="Page 1" aria-current="page">1</a></li>' +
				'<li><a href="/recipes?page=2" aria-label="Page 2">2</a></li>' +
				'<li><a href="/recipes?page=2" rel="next">Next</a></li>' +
				"</ul></nav>",
		);
		const second = await get("/recipes?page=2");
		expect(second.headers.get("x-cache")).toBe("MISS");
		const secondHtml = await second.text();
		expect(secondHtml).toContain("<title>Recipes · Page 2 · Acme Bakery</title>");
		expect(secondHtml).toContain(
			'<link rel="alternate" hreflang="fr" href="https://bakery.live.test/fr/recipes?page=2">',
		);
		expect(/<main[^>]*>([\s\S]*)<\/main>/.exec(secondHtml)?.[1]).toBe(
			"<p>Crumble</p>" +
				'<nav class="wc-pagination" aria-label="Pages"><ul>' +
				'<li><a href="/recipes" rel="prev">Previous</a></li>' +
				'<li><a href="/recipes" aria-label="Page 1">1</a></li>' +
				'<li><a href="/recipes?page=2" aria-label="Page 2" aria-current="page">2</a></li>' +
				"</ul></nav>",
		);
		expect((await get("/recipes?page=2")).headers.get("x-cache")).toBe("HIT");
		expect(await mainOf(await get("/recipes"))).toContain("<p>Apple tart</p>");
		expect(await mainOf(await get("/fr/recipes?page=2"))).toContain('<a href="/fr/recipes" rel="prev">Précédente</a>');
	});

	test("page 1 is the page itself; pages past the last, and other numbers, are not found", async () => {
		await archive("{{@loop paged-recipes as r}}<p>{{ r.title }}</p>{{/loop}}{{@pagination paged-recipes}}");

		const one = await get("/recipes?page=1");
		expect(one.status).toBe(301);
		expect(one.headers.get("location")).toBe("/recipes");
		for (const page of ["3", "0", "02", "abc", "-1", "9999"]) {
			expect((await get(`/recipes?page=${page}`)).status).toBe(404);
		}
		expect((await get("/recipes?page=2&page=2")).status).toBe(404);
		// Other parameters are no part of the page.
		await get("/recipes");
		expect((await get("/recipes?utm=x")).headers.get("x-cache")).toBe("HIT");
	});

	test("Loops paginate on Pages; on an Entry's page a page number goes to the page itself", async () => {
		const { template } = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				"<main>{{@outlet}}{{@loop paged-recipes as r}}<p>{{ r.title }}</p>{{/loop}}{{@pagination paged-recipes}}</main>",
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const { entry: about } = await staff.api.entries.create({ siteId, postTypeId: pagesId, title: "About" });
		await staff.api.entries.publish({ siteId, entryId: about.id });
		const entryTemplate = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: recipesId,
			markup: "<h1>{{ title }}</h1>",
		});
		await staff.api.templates.publish({ siteId, templateId: entryTemplate.template.id });

		const paged = await (await get("/about?page=2")).text();
		expect(/<main[^>]*>([\s\S]*)<\/main>/.exec(paged)?.[1]).toContain("<p>Crumble</p>");
		// Its title says which page it is, and its alternates are that page in each language, as an Archive's.
		expect(paged).toContain("<title>About · Page 2 · Acme Bakery</title>");
		expect(paged).toContain('<link rel="alternate" hreflang="fr" href="https://bakery.live.test/fr/about?page=2">');
		expect(paged).toContain('<link rel="alternate" hreflang="x-default" href="https://bakery.live.test/about?page=2">');
		const onEntry = await get("/recipes/brioche?page=2");
		expect(onEntry.status).toBe(301);
		expect(onEntry.headers.get("location")).toBe("/recipes/brioche");
		expect(await mainOf(await get("/recipes/brioche"))).toBe("<h1>Brioche</h1><p>Apple tart</p><p>Brioche</p>");
	});
});

describe("one path, one page", () => {
	test("a published Page at the address keeps the Archive template from being published, and the other way round", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Events",
			key: "events",
			urlPattern: "/events/{slug}",
		});
		const { entry: page } = await staff.api.entries.create({ siteId, postTypeId: pagesId, title: "Events" });
		await staff.api.entries.publish({ siteId, entryId: page.id });
		const { template } = await staff.api.templates.saveArchiveTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: "<p>Events</p>",
		});

		await expect(staff.api.templates.publish({ siteId, templateId: template.id })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/events", by: { kind: "page", id: page.id } },
		});
		await staff.api.entries.saveDraft({ siteId, entryId: page.id, slug: "whats-on" });
		// Slugs never change on their own: the French address keeps the slug it was published with.
		await expect(
			staff.api.entries
				.publish({ siteId, entryId: page.id })
				.then(() => staff.api.templates.publish({ siteId, templateId: template.id })),
		).rejects.toMatchObject({ code: "PATH_TAKEN", data: { path: "/fr/events" } });
		await staff.api.entries.saveDraft({ siteId, entryId: page.id, language: "fr", slug: "agenda" });
		await staff.api.entries.publish({ siteId, entryId: page.id });
		await staff.api.templates.publish({ siteId, templateId: template.id });

		const { entry: another } = await staff.api.entries.create({ siteId, postTypeId: pagesId, title: "Events" });
		await expect(staff.api.entries.publish({ siteId, entryId: another.id })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/events", by: { kind: "archive", postTypeId: postType.id } },
		});
	});

	test("a URL pattern can't own a published Archive template's address, nor move it onto a Page", async () => {
		const { postType: news } = await staff.api.postTypes.create({
			siteId,
			name: "News",
			key: "news",
			urlPattern: "/news/{slug}",
		});
		const { template } = await staff.api.templates.saveArchiveTemplateMarkup({
			siteId,
			postTypeId: news.id,
			markup: "<p>News</p>",
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });

		await expect(
			staff.api.postTypes.create({ siteId, name: "Stories", key: "stories", urlPattern: "/{slug}" }),
		).rejects.toMatchObject({ code: "PATH_TAKEN", data: { by: { kind: "archive" } } });
		await expect(
			staff.api.postTypes.create({ siteId, name: "Stories", key: "stories", urlPattern: "/{slug}/story" }),
		).resolves.toBeDefined();
		await expect(
			staff.api.postTypes.update({ siteId, postTypeId: news.id, urlPattern: "/about/{slug}" }),
		).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/about", by: { kind: "page" } },
		});
		await staff.api.postTypes.update({ siteId, postTypeId: news.id, urlPattern: "/latest/{slug}" });
		expect((await get("/latest")).status).toBe(200);
		expect((await get("/news")).status).toBe(404);
	});
});
