// Sitemaps (spec story 117): each of a Site's domains answers `/sitemap.xml`, an index of one
// sitemap per Post Type (Pages included), each listing the indexable Entries visitors find on that
// domain with when they were last published and their `hreflang` alternates.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";
import { readSitemap, readSitemapIndex, type SitemapUrl } from "../harness/xml.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = { siteId: string; slug: string; blogId: string; pagesId: string; origin: string };

/** A live Site with Pages and a blog whose Entry template is published. */
async function newSite(options: { languages?: string[] } = {}): Promise<TestSite> {
	const slug = `sitemaps-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
	for (const code of options.languages ?? []) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "blog",
		urlPattern: "/blog/{slug}",
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	return {
		siteId,
		slug,
		blogId: postType.id,
		pagesId: postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "",
		origin,
	};
}

async function published(
	site: TestSite,
	postTypeId: string,
	input: { title: string; seo?: Record<string, unknown>; hiddenLanguages?: string[] },
): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId, ...input });
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

/** The test clock's time as a sitemap writes it: a W3C datetime to the second. */
function now(): string {
	return install.clock
		.now()
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z");
}

/** A sitemap file as a search engine reads it: well-formed, and answered as XML. */
async function file(url: string): Promise<string> {
	const response = await install.request(url);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
	expectSiteHeaders(response);
	return response.text();
}

/** Every URL the Site's sitemaps list on a domain, following its index, sorted by address. */
async function listed(origin: string): Promise<SitemapUrl[]> {
	const urls: SitemapUrl[] = [];
	for (const sitemap of readSitemapIndex(await file(`${origin}/sitemap.xml`))) {
		urls.push(...readSitemap(await file(sitemap.loc)));
	}
	return urls.sort((a, b) => a.loc.localeCompare(b.loc));
}

describe("the index", () => {
	test("lists one sitemap per Post Type with Entries, Pages first, each with its newest change", async () => {
		const site = await newSite();
		const pageAt = now();
		await published(site, site.pagesId, { title: "About us" });
		await install.clock.advance(60_000);
		const postAt = now();
		await published(site, site.blogId, { title: "Fresh bread" });

		const index = readSitemapIndex(await file(`${site.origin}/sitemap.xml`));

		expect(index).toEqual([
			{ loc: `${site.origin}/sitemaps/page-1.xml`, lastmod: pageAt },
			{ loc: `${site.origin}/sitemaps/blog-1.xml`, lastmod: postAt },
		]);
	});

	test("a Site with nothing published yet lists no sitemap", async () => {
		const site = await newSite();

		expect(readSitemapIndex(await file(`${site.origin}/sitemap.xml`))).toEqual([]);
		expect((await install.request(`${site.origin}/sitemaps/blog-1.xml`)).status).toBe(404);
	});
});

describe("a Post Type's sitemap", () => {
	test("lists each published Entry at its address with when it was last published", async () => {
		const site = await newSite();
		const freshAt = now();
		await published(site, site.blogId, { title: "Fresh bread" });
		await install.clock.advance(3_600_000);
		const ryeAt = now();
		await published(site, site.blogId, { title: "Rye loaves" });

		const urls = readSitemap(await file(`${site.origin}/sitemaps/blog-1.xml`));

		expect(urls.sort((a, b) => a.loc.localeCompare(b.loc))).toEqual([
			{ loc: `${site.origin}/blog/fresh-bread`, lastmod: freshAt, alternates: [] },
			{ loc: `${site.origin}/blog/rye-loaves`, lastmod: ryeAt, alternates: [] },
		]);
	});

	test("lists Pages at their paths, the home page at the root", async () => {
		const site = await newSite();
		const home = await published(site, site.pagesId, { title: "Welcome" });
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: home });
		const about = await published(site, site.pagesId, { title: "About" });
		const { entry: team } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Our team",
			parentId: about,
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: team.id });

		expect((await listed(site.origin)).map((url) => url.loc)).toEqual([
			`${site.origin}/`,
			`${site.origin}/about`,
			`${site.origin}/about/our-team`,
		]);
	});
});

describe("what is left out", () => {
	test("Drafts never published, and the Draft of a published Entry: only what visitors see is listed", async () => {
		const site = await newSite();
		await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.blogId, title: "Not yet" });
		const entryId = await published(site, site.blogId, { title: "Fresh bread" });
		const at = now();
		await install.clock.advance(60_000);
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, title: "Fresh bread, renamed" });

		expect(await listed(site.origin)).toEqual([
			{ loc: `${site.origin}/blog/fresh-bread`, lastmod: at, alternates: [] },
		]);
	});

	test("noindex Entries", async () => {
		const site = await newSite();
		await published(site, site.blogId, { title: "Fresh bread" });
		await published(site, site.blogId, { title: "Staff notes", seo: { noindex: true } });

		expect((await listed(site.origin)).map((url) => url.loc)).toEqual([`${site.origin}/blog/fresh-bread`]);
	});

	test("an Entry whose canonical URL is another address; one pointing at itself stays", async () => {
		const site = await newSite();
		await published(site, site.blogId, { title: "Fresh bread" });
		await published(site, site.blogId, { title: "Bread again", seo: { canonical: "/blog/fresh-bread" } });
		await published(site, site.blogId, { title: "Syndicated", seo: { canonical: "https://news.example/bread" } });
		await published(site, site.blogId, { title: "Own address", seo: { canonical: "/blog/own-address" } });

		expect((await listed(site.origin)).map((url) => url.loc)).toEqual([
			`${site.origin}/blog/fresh-bread`,
			`${site.origin}/blog/own-address`,
		]);
	});

	test("the Site's 404 pages and its search results page, which are never indexed", async () => {
		const site = await newSite({ languages: ["fr"] });
		await published(site, site.pagesId, { title: "About" });
		const missing = await published(site, site.pagesId, { title: "Missing" });
		const manquant = await published(site, site.pagesId, { title: "Manquant" });
		const search = await published(site, site.pagesId, { title: "Search" });
		await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: missing });
		await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: manquant, language: "fr" });
		await staff.api.pages.setSearchPage({ siteId: site.siteId, pageId: search });

		expect((await listed(site.origin)).map((url) => url.loc)).toEqual([
			`${site.origin}/about`,
			`${site.origin}/fr/about`,
		]);
	});

	test("a Post Type whose Entry template isn't published has no pages, so no sitemap", async () => {
		const site = await newSite();
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Team",
			urlPattern: "/team/{slug}",
		});
		await published(site, postType.id, { title: "Ada" });

		const index = readSitemapIndex(await file(`${site.origin}/sitemap.xml`));
		expect(index.map((sitemap) => sitemap.loc)).toEqual([]);
		expect((await install.request(`${site.origin}/sitemaps/${postType.key}-1.xml`)).status).toBe(404);
	});

	test("pages of a paginated Loop, filtered and searched pages: only each page's own address is listed", async () => {
		const site = await newSite();
		await published(site, site.blogId, { title: "Fresh bread" });

		for (const url of await listed(site.origin)) expect(new URL(url.loc).search).toBe("");
		expect((await install.request(`${site.origin}/sitemaps/blog-2.xml`)).status).toBe(404);
		expect((await install.request(`${site.origin}/sitemaps/blog-1.xml?page=2`)).status).toBe(200);
	});
});

describe("Archive pages", () => {
	test("are listed first in their Post Type's sitemap while their Archive template is published", async () => {
		const site = await newSite();
		await published(site, site.blogId, { title: "Fresh bread" });
		await install.clock.advance(60_000);
		const saved = await staff.api.templates.saveArchiveTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.blogId,
			markup: "<h1>Blog</h1>",
		});
		const archiveAt = now();
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });

		const urls = readSitemap(await file(`${site.origin}/sitemaps/blog-1.xml`));

		expect(urls[0]).toEqual({ loc: `${site.origin}/blog`, lastmod: archiveAt, alternates: [] });
		expect(urls.map((url) => url.loc)).toContain(`${site.origin}/blog/fresh-bread`);
	});
});

/** The `hreflang` alternates in a page's head, as `[hreflang, href]`. */
async function headAlternates(url: string): Promise<[string, string][]> {
	const html = await (await install.request(url)).text();
	return [...html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g)].map(
		(match): [string, string] => [match[1] ?? "", match[2] ?? ""],
	);
}

describe("languages", () => {
	test("each language's address is listed with the same hreflang alternates as its page's head", async () => {
		const site = await newSite({ languages: ["fr", "pt-BR"] });
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.blogId,
			title: "Fresh bread",
		});
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: entry.id, language: "fr", slug: "pain-frais" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });

		const urls = await listed(site.origin);

		expect(urls.map((url) => url.loc)).toEqual([
			`${site.origin}/blog/fresh-bread`,
			`${site.origin}/fr/blog/pain-frais`,
			`${site.origin}/pt-br/blog/fresh-bread`,
		]);
		for (const url of urls) expect(url.alternates).toEqual(await headAlternates(url.loc));
		expect(urls[0]?.alternates).toEqual([
			["en", `${site.origin}/blog/fresh-bread`],
			["fr", `${site.origin}/fr/blog/pain-frais`],
			["pt-BR", `${site.origin}/pt-br/blog/fresh-bread`],
			["x-default", `${site.origin}/blog/fresh-bread`],
		]);
	});

	test("an Entry hidden in a language has no address there, nor an alternate", async () => {
		const site = await newSite({ languages: ["fr"] });
		await published(site, site.blogId, { title: "Fresh bread", hiddenLanguages: ["fr"] });
		await published(site, site.pagesId, { title: "About" });

		const urls = await listed(site.origin);

		expect(urls.map((url) => url.loc)).toEqual([
			`${site.origin}/about`,
			`${site.origin}/blog/fresh-bread`,
			`${site.origin}/fr/about`,
		]);
		const bread = urls.find((url) => url.loc.endsWith("/blog/fresh-bread"));
		expect(bread?.alternates).toEqual([
			["en", `${site.origin}/blog/fresh-bread`],
			["x-default", `${site.origin}/blog/fresh-bread`],
		]);
		expect(bread?.alternates).toEqual(await headAlternates(`${site.origin}/blog/fresh-bread`));
	});

	test("an Archive page is listed in every language, with its alternates", async () => {
		const site = await newSite({ languages: ["fr"] });
		const saved = await staff.api.templates.saveArchiveTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.blogId,
			markup: "<h1>Blog</h1>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });

		const urls = await listed(site.origin);

		expect(urls.map((url) => url.loc)).toEqual([`${site.origin}/blog`, `${site.origin}/fr/blog`]);
		for (const url of urls) expect(url.alternates).toEqual(await headAlternates(url.loc));
	});

	test("a language on its own domain is listed there only; each domain's robots.txt names its own sitemap", async () => {
		const site = await newSite({ languages: ["fr", "de"] });
		await staff.api.languages.update({ siteId: site.siteId, code: "fr", domain: `${site.slug}.fr` });
		install.connectDomain(`${site.slug}.fr`);
		await install.clock.advance(60_000);
		expect((await install.drainJobs()).failed).toEqual([]);
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.blogId,
			title: "Fresh bread",
		});
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: entry.id, language: "fr", slug: "pain-frais" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		const french = `https://${site.slug}.fr`;

		const main = await listed(site.origin);
		const own = await listed(french);

		expect(main.map((url) => url.loc)).toEqual([
			`${site.origin}/blog/fresh-bread`,
			`${site.origin}/de/blog/fresh-bread`,
		]);
		expect(own.map((url) => url.loc)).toEqual([`${french}/blog/pain-frais`]);
		const alternates: [string, string][] = [
			["en", `${site.origin}/blog/fresh-bread`],
			["fr", `${french}/blog/pain-frais`],
			["de", `${site.origin}/de/blog/fresh-bread`],
			["x-default", `${site.origin}/blog/fresh-bread`],
		];
		for (const url of [...main, ...own]) {
			expect(url.alternates).toEqual(alternates);
			expect(url.alternates).toEqual(await headAlternates(url.loc));
		}
		expect(await (await install.request(`${french}/robots.txt`)).text()).toContain(`Sitemap: ${french}/sitemap.xml\n`);
	});
});

describe("the Staging address", () => {
	test("offers no sitemap, even to the people reviewing it", async () => {
		const site = await newSite();
		await published(site, site.blogId, { title: "Fresh bread" });
		const { openStaging } = await import("../harness/staging.ts");
		const reviewer = await openStaging(install, staff, site.siteId);

		const index = await reviewer.page("/sitemap.xml");
		const part = await reviewer.page("/sitemaps/blog-1.xml");

		expect(index.status).toBe(404);
		expect(part.status).toBe(404);
		expect(index.headers.get("x-robots-tag")).toBe("noindex");
	});
});

describe("a Post Type Staff leave out", () => {
	test("has no sitemap, while its Entries' pages still answer; only Staff choose", async () => {
		const site = await newSite();
		await published(site, site.blogId, { title: "Fresh bread" });
		await published(site, site.pagesId, { title: "About" });

		const { postType } = await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.blogId,
			sitemap: false,
		});

		expect(postType.sitemap).toBe(false);
		expect(readSitemapIndex(await file(`${site.origin}/sitemap.xml`)).map((sitemap) => sitemap.loc)).toEqual([
			`${site.origin}/sitemaps/page-1.xml`,
		]);
		expect((await install.request(`${site.origin}/sitemaps/blog-1.xml`)).status).toBe(404);
		expect((await install.request(`${site.origin}/blog/fresh-bread`)).status).toBe(200);
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
		await expect(
			owner.api.postTypes.update({ siteId: site.siteId, postTypeId: site.blogId, sitemap: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
