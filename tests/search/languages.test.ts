// Site search in every language (ADR 0021): one index per Site and language. A page in a language
// searches that language's documents, read with the Default language's values where it has none of
// its own, words found in their forms as the language writes them; an Entry hidden in a language is
// never found there. The search results page is at its Page's path in each language, on the
// language's own domain too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let recipesId: string;
let searchPageId: string;
const SITE = "https://bakery.sites.test";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	await staff.api.languages.add({ siteId, code: "fr" });
	recipesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [{ key: "body", label: "Body", type: "body" }],
		})
	).postType.id;
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: recipesId,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const site = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header>{{@search}}</header><main>{{@outlet}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: site.template.id });

	const brioche = await recipe("Brioche", "Rich and buttery.");
	await staff.api.entries.saveDraft({
		siteId,
		entryId: brioche,
		language: "fr",
		title: "Brioche dorée",
		slug: "brioche-doree",
		fields: { body: [{ type: "paragraph", text: "Riche et beurrée, cuite chaque matin." }] },
	});
	await staff.api.entries.publish({ siteId, entryId: brioche });
	await recipe("Crumble", "Apples under a crisp top.");
	await recipe("Sourdough", "A slow bread.", ["fr"]);

	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pages = postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "Search" });
	await staff.api.entries.saveDraft({
		siteId,
		entryId: entry.id,
		language: "fr",
		title: "Recherche",
		slug: "recherche",
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	searchPageId = entry.id;
	await staff.api.pages.setSearchPage({ siteId, pageId: searchPageId });
});

afterAll(async () => {
	await install.close();
});

async function recipe(title: string, text: string, hiddenLanguages: string[] = []): Promise<string> {
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: recipesId,
		title,
		fields: { body: [{ type: "paragraph", text }] },
		hiddenLanguages,
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return entry.id;
}

async function search(url: string): Promise<{ html: string; hits: { href: string; title: string }[] }> {
	const response = await install.request(url);
	expect(response.status).toBe(200);
	const html = await expectSafePage(response);
	const hits = [...html.matchAll(/<li><h2><a href="([^"]*)">([^<]*)<\/a><\/h2>/g)].map(([, href = "", title = ""]) => ({
		href,
		title,
	}));
	return { html, hits };
}

async function settle() {
	await install.clock.advance(60_000);
	const drained = await install.drainJobs();
	expect(drained.failed).toEqual([]);
}

describe("a language's search results page", () => {
	test("is at the Page's path in that language, and finds Entries by their values there", async () => {
		const { html, hits } = await search(`${SITE}/fr/recherche?q=dor%C3%A9e`);

		expect(html).toContain('<html lang="fr"');
		expect(hits).toEqual([{ href: "/fr/recipes/brioche-doree", title: "Brioche dorée" }]);
		expect(html).toContain("<p>1 résultat pour « dorée »</p>");
		expect(html).toContain("<title>Résultats pour « dorée » · Acme Bakery</title>");
		expect(html).toContain('<label class="wc-visually-hidden" for="wc-search-1">Rechercher sur le site</label>');
		expect(html).toContain("<h1>Recherche</h1>");
	});

	test("finds words in their forms as the language writes them", async () => {
		const { html, hits } = await search(`${SITE}/fr/recherche?q=beurr%C3%A9es`);

		expect(hits.map((hit) => hit.title)).toEqual(["Brioche dorée"]);
		expect(html).toContain("<mark>beurrée</mark>");
	});

	test("searches the Default language's values where an Entry has none of its own", async () => {
		const { hits } = await search(`${SITE}/fr/recherche?q=crumble`);

		expect(hits).toEqual([{ href: "/fr/recipes/crumble", title: "Crumble" }]);
	});

	test("searches only that language: the English page doesn't find the French words", async () => {
		expect((await search(`${SITE}/search?q=dor%C3%A9e`)).hits).toEqual([]);
		expect((await search(`${SITE}/search?q=buttery`)).hits.map((hit) => hit.title)).toEqual(["Brioche"]);
	});

	test("never finds an Entry hidden in that language", async () => {
		expect((await search(`${SITE}/fr/recherche?q=sourdough`)).hits).toEqual([]);
		expect((await search(`${SITE}/search?q=sourdough`)).hits.map((hit) => hit.title)).toEqual(["Sourdough"]);
	});

	test("is where the Search element of a page in that language sends visitors", async () => {
		const french = await expectSafePage(await install.request(`${SITE}/fr/recipes/crumble`));
		expect(french).toContain('<form class="wc-search" role="search" method="get" action="/fr/recherche">');
		const english = await expectSafePage(await install.request(`${SITE}/recipes/crumble`));
		expect(english).toContain('<form class="wc-search" role="search" method="get" action="/search">');
	});
});

describe("languages changing", () => {
	test("a language added later finds every published Entry once the index is rebuilt", async () => {
		await staff.api.languages.add({ siteId, code: "de" });
		expect((await search(`${SITE}/de/search?q=brioche`)).hits).toEqual([]);

		await settle();

		expect((await search(`${SITE}/de/search?q=brioche`)).hits).toEqual([
			{ href: "/de/recipes/brioche", title: "Brioche" },
		]);
		expect((await search(`${SITE}/de/search?q=brioche`)).html).toContain("<p>1 Ergebnis für „brioche“</p>");
	});

	test("on a language's own domain, the search results page is there, without a prefix", async () => {
		await staff.api.languages.update({ siteId, code: "fr", domain: "boulangerie.example" });
		install.connectDomain("boulangerie.example");
		await settle();

		const { hits, html } = await search("https://boulangerie.example/recherche?q=dor%C3%A9e");
		expect(hits.map((hit) => hit.title)).toEqual(["Brioche dorée"]);
		expect(html).toContain('<form class="wc-search" role="search" method="get" action="/recherche">');
		// A hit links to its page on the language's domain (Loop items' addresses carry the prefix,
		// which that domain sends on to the address without it).
		const followed = await install.request(`https://boulangerie.example${hits[0]?.href}`);
		expect([200, 301]).toContain(followed.status);
		const landed = followed.status === 301 ? (followed.headers.get("location") ?? "") : (hits[0]?.href ?? "");
		expect(landed).toBe("https://boulangerie.example/recipes/brioche-doree");
	});
});
