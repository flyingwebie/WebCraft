// A big Site's sitemaps (spec story 117): past the protocol's limits (50,000 addresses or 50 MB in one
// file) a Post Type's sitemap is split into numbered parts, each listed in the index. This Install
// lowers both limits so a few Entries show it.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { readSitemap, readSitemapIndex, type SitemapUrl } from "../harness/xml.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

const LIMITS = { urls: 3, bytes: 1_500 };

beforeAll(async () => {
	install = await createTestInstall({ sitemapLimits: LIMITS });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

async function newSite(languages: string[] = []): Promise<{ siteId: string; blogId: string; origin: string }> {
	const slug = `sitemap-parts-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog",
		key: "blog",
		urlPattern: "/blog/{slug}",
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	return { siteId, blogId: postType.id, origin };
}

async function publish(siteId: string, postTypeId: string, titles: string[]): Promise<void> {
	for (const title of titles) {
		const { entry } = await staff.api.entries.create({ siteId, postTypeId, title });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		await install.clock.advance(1_000);
	}
}

async function text(url: string): Promise<string> {
	const response = await install.request(url);
	expect(response.status).toBe(200);
	return response.text();
}

/** Each part the index lists, read as a search engine reads it, with its size in bytes. */
async function parts(origin: string) {
	const index = readSitemapIndex(await text(`${origin}/sitemap.xml`));
	return Promise.all(
		index.map(async (entry) => {
			const xml = await text(entry.loc);
			return { ...entry, bytes: new TextEncoder().encode(xml).byteLength, urls: readSitemap(xml) };
		}),
	);
}

const newest = (urls: SitemapUrl[]) =>
	urls
		.map((url) => url.lastmod ?? "")
		.sort()
		.at(-1);

test("a Post Type past the limit is split into numbered parts, listing every address once", async () => {
	const site = await newSite();
	const titles = ["One", "Two", "Three", "Four", "Five", "Six", "Seven"];
	await publish(site.siteId, site.blogId, titles);

	const found = await parts(site.origin);

	expect(found.map((part) => part.loc)).toEqual([
		`${site.origin}/sitemaps/blog-1.xml`,
		`${site.origin}/sitemaps/blog-2.xml`,
		`${site.origin}/sitemaps/blog-3.xml`,
	]);
	expect(found.map((part) => part.urls.length)).toEqual([3, 3, 1]);
	const all = found.flatMap((part) => part.urls.map((url) => url.loc)).sort();
	expect(all).toEqual(titles.map((title) => `${site.origin}/blog/${title.toLowerCase()}`).sort());
	// Each part's date in the index is its newest address's.
	for (const part of found) expect(part.lastmod).toBe(newest(part.urls));
	expect((await install.request(`${site.origin}/sitemaps/blog-4.xml`)).status).toBe(404);
	expect((await install.request(`${site.origin}/sitemaps/blog-0.xml`)).status).toBe(404);
});

test("an Entry's languages may fall into two parts; no part goes past either limit", async () => {
	const site = await newSite(["fr", "de"]);
	await publish(site.siteId, site.blogId, ["Bread", "Rolls", "Buns"]);

	const found = await parts(site.origin);

	const all = found.flatMap((part) => part.urls.map((url) => url.loc));
	expect(all).toHaveLength(9);
	expect(new Set(all).size).toBe(9);
	for (const part of found) {
		expect(part.urls.length).toBeLessThanOrEqual(LIMITS.urls);
		expect(part.bytes).toBeLessThanOrEqual(LIMITS.bytes);
		expect(part.urls.length).toBeGreaterThan(0);
	}
	// Each address carries four alternates, so the byte limit splits sooner than the address limit.
	expect(found.some((part) => part.urls.length < LIMITS.urls)).toBe(true);
	expect(found.length).toBeGreaterThan(3);
});
