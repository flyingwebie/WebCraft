// Site search as visitors use it (ADR 0021): the Site's search results page, a Page Staff choose,
// lists the published Entries of searchable Post Types whose Searched fields match `q`, best first,
// through the Search results template's Loop, with highlighted snippets, the hit count and pages.
// It works without JavaScript, is never cached and never indexed by search engines.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ipv6Network } from "../harness/addresses.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let recipesId: string;
let searchPageId: string;
const SITE = "https://bakery.live.test";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	recipesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [
				{ key: "summary", label: "Summary", type: "text" },
				{ key: "body", label: "Body", type: "body" },
			],
		})
	).postType.id;
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: recipesId,
		markup: "<article><h1>{{ title }}</h1>{{ body }}</article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	await recipe("Brioche", "Rich and buttery, baked every morning.");
	await recipe("Sourdough", "A slow bread with a crisp crust.");
	await recipe("Apple tart", "Sweet pastry with apples.");
	await recipe("Sweet buns", "Soft rolls.");
	searchPageId = await page("Search", "search");
	await staff.api.pages.setSearchPage({ siteId, pageId: searchPageId });
});

afterAll(async () => {
	await install.close();
});

async function recipe(title: string, text: string, fields: Record<string, unknown> = {}): Promise<string> {
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: recipesId,
		title,
		fields: { body: [{ type: "paragraph", text }], ...fields },
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return entry.id;
}

async function page(title: string, slug: string): Promise<string> {
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pages = postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pages?.id ?? "", title, slug });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return entry.id;
}

/** The hits a results page lists, best first: each one's link and title. */
function hits(html: string): { href: string; title: string }[] {
	return [...html.matchAll(/<li><h2><a href="([^"]*)">([^<]*)<\/a><\/h2>/g)].map(([, href = "", title = ""]) => ({
		href,
		title,
	}));
}

let visitors = 0;

/** A search by a visitor of their own (each address may search 30 times a minute). */
async function search(query: string, path = "/search"): Promise<{ response: Response; html: string }> {
	const address = `203.0.113.${++visitors % 250}`;
	const url = `${SITE}${path}?q=${encodeURIComponent(query)}`;
	const response = await install.request(fromAddress(new Request(url), address));
	const html = await expectSafePage(response);
	return { response, html };
}

describe("searching", () => {
	test("a visitor finds a published Entry by a word of its title, linked to its page", async () => {
		const { response, html } = await search("brioche");

		expect(response.status).toBe(200);
		expect(hits(html)).toEqual([{ href: "/recipes/brioche", title: "Brioche" }]);
	});

	test("the page says how many hits there are, for what, and titles itself after the query", async () => {
		const one = await search("brioche");
		expect(one.html).toContain("<p>1 result for “brioche”</p>");
		expect(one.html).toContain("<title>Results for “brioche” · Acme Bakery</title>");

		const many = await search("sweet");
		expect(many.html).toContain("<p>2 results for “sweet”</p>");
	});

	test("each hit has a snippet of where its text matched, the matched words marked", async () => {
		const { html } = await search("buttery");

		expect(html).toContain("<p>Rich and <mark>buttery</mark>, baked every morning.</p>");
	});

	test("words are found in any of their forms, in the page's language (breads finds bread)", async () => {
		const { html } = await search("breads");

		expect(hits(html).map((hit) => hit.title)).toEqual(["Sourdough"]);
	});

	test("hits matching the title (weight A) come before hits matching the body (B)", async () => {
		const { html } = await search("sweet");

		expect(hits(html).map((hit) => hit.title)).toEqual(["Sweet buns", "Apple tart"]);
	});

	test("a query of several words finds Entries holding all of them; a quoted phrase, that phrase", async () => {
		expect(hits((await search("crisp slow")).html).map((hit) => hit.title)).toEqual(["Sourdough"]);
		expect(hits((await search('"slow bread"')).html).map((hit) => hit.title)).toEqual(["Sourdough"]);
		expect(hits((await search('"bread slow"')).html)).toEqual([]);
		expect(hits((await search("sweet -apples")).html).map((hit) => hit.title)).toEqual(["Sweet buns"]);
	});

	test("nothing found: the page says so, and what to try, with no list", async () => {
		const { response, html } = await search("croissant");

		expect(response.status).toBe(200);
		expect(html).toContain("<p>No results for “croissant”.</p>");
		expect(html).toContain("<p>Check the spelling, or try other words.</p>");
		expect(html).not.toContain("<ol>");
	});

	test("an empty query searches for nothing: the page shows its search box alone", async () => {
		for (const query of ["", "   "]) {
			const { response, html } = await search(query);
			expect(response.status).toBe(200);
			expect(hits(html)).toEqual([]);
			expect(html).not.toContain("result");
			expect(html).toContain('<input class="wc-search-input" type="search" id="wc-search-1" name="q" maxlength="200"');
		}
		const bare = await install.request(`${SITE}/search`);
		expect(bare.status).toBe(200);
		expect(hits(await expectSafePage(bare))).toEqual([]);
	});

	test("the search box on the results page shows the query, and searches again from there", async () => {
		const { html } = await search("brioche");

		expect(html).toContain('<form class="wc-search" role="search" method="get" action="/search">');
		expect(html).toContain('<label class="wc-visually-hidden" for="wc-search-1">Search the site</label>');
		expect(html).toContain('name="q" value="brioche" maxlength="200"');
		expect(html).toContain('<button class="wc-search-button" type="submit">Search</button>');
	});
});

describe("what is never found", () => {
	test("an Entry never published, and changes not published yet", async () => {
		const { entry } = await staff.api.entries.create({
			siteId,
			postTypeId: recipesId,
			title: "Secret scones",
		});
		expect(hits((await search("scones")).html)).toEqual([]);

		await staff.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Secret scones" });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		await staff.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Secret muffins" });
		expect(hits((await search("scones")).html).map((hit) => hit.title)).toEqual(["Secret scones"]);
		expect(hits((await search("muffins")).html)).toEqual([]);

		await staff.api.entries.publish({ siteId, entryId: entry.id });
		expect(hits((await search("muffins")).html).map((hit) => hit.title)).toEqual(["Secret muffins"]);
		expect(hits((await search("scones")).html)).toEqual([]);
	});

	test("a deleted Entry", async () => {
		const id = await recipe("Fruit loaf", "Raisins.");
		expect(hits((await search("raisins")).html)).toHaveLength(1);

		const first = await staff.api.entries.delete({ siteId, entryId: id });
		if (first.deleted) throw new Error("deleted without confirming");
		await staff.api.entries.delete({ siteId, entryId: id, confirmation: first.confirmation.id });

		expect(hits((await search("raisins")).html)).toEqual([]);
	});

	test("the Entries of a Post Type Staff mark as not searchable, until they mark it searchable", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Suppliers",
			key: "suppliers",
			urlPattern: "/suppliers/{slug}",
			searchable: false,
		});
		const template = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: "<h1>{{ title }}</h1>",
		});
		await staff.api.templates.publish({ siteId, templateId: template.template.id });
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Flour mill" });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		expect(hits((await search("mill")).html)).toEqual([]);

		await staff.api.postTypes.update({ siteId, postTypeId: postType.id, searchable: true });

		expect(hits((await search("mill")).html)).toEqual([{ href: "/suppliers/flour-mill", title: "Flour mill" }]);
	});

	test("the Entries of a Post Type with no published Entry template, which have no page", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Notes", urlPattern: "/notes/{slug}" });
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Kitchen notebook" });
		await staff.api.entries.publish({ siteId, entryId: entry.id });

		expect(hits((await search("notebook")).html)).toEqual([]);
	});

	test("the search results page itself; other published Pages are found", async () => {
		await page("Search tips", "search-tips");

		expect(hits((await search("search")).html)).toEqual([{ href: "/search-tips", title: "Search tips" }]);
	});
});

describe("what visitors type", () => {
	test("query syntax and markup are only ever text: never an error, always escaped", async () => {
		for (const query of [
			"<script>alert(1)</script>",
			"'; drop table entries; --",
			"a & | ! : * ( ) <-> \\",
			'"',
			"-",
		]) {
			const { response, html } = await search(query);
			expect(response.status).toBe(200);
			expect(html).not.toContain("<script>alert");
		}
		const { html } = await search("<b>bold</b>");
		expect(html).toContain('value="&lt;b&gt;bold&lt;/b&gt;"');
		expect(html).toContain("<p>No results for “&lt;b&gt;bold&lt;/b&gt;”.</p>");
	});

	test("text in an Entry that looks like markup is never markup in its snippet", async () => {
		await recipe("Tag cake", 'Decorated with <img src=x onerror="alert(1)"> icing.');
		await recipe("Sum cake", 'Bake at 5 < 6 & "sweet" glaze <b unclosed.');

		const tag = (await search("icing")).html;
		expect(tag).toContain("<p>Decorated with   <mark>icing</mark>.</p>");
		expect(tag).not.toContain("<img src=x");

		const sum = (await search("glaze")).html;
		expect(sum).toContain('<p>Bake at 5 &lt; 6 &amp; "sweet" <mark>glaze</mark> &lt;b unclosed.</p>');
	});

	test("a query is cut at 200 characters", async () => {
		const long = `${"a".repeat(190)} brioche ${"b".repeat(50)}`;

		const { html } = await search(long);

		const shown = /name="q" value="([^"]*)"/.exec(html)?.[1] ?? "";
		expect([...shown]).toHaveLength(200);
		expect(shown).toBe(long.slice(0, 200));
	});
});

describe("answers", () => {
	test("a results page is never cached, nor indexed by search engines", async () => {
		for (let visit = 0; visit < 2; visit++) {
			const { response } = await search("brioche");
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("x-robots-tag")).toBe("noindex");
			expect(response.headers.get("etag")).toBeNull();
			expect(response.headers.get("x-cache")).toBeNull();
		}
	});

	test("hits come ten to a page; the page links keep the query", async () => {
		for (let index = 1; index <= 11; index++) await recipe(`Cake ${index}`, "A sponge to share.");

		const first = await search("sponge");
		expect(first.html).toContain("<p>11 results for “sponge”</p>");
		expect(hits(first.html)).toHaveLength(10);
		expect(first.html).toContain('<a href="/search?q=sponge&amp;page=2" aria-label="Page 2">2</a>');

		const second = await install.request(`${SITE}/search?q=sponge&page=2`);
		const html = await expectSafePage(second);
		expect(hits(html)).toHaveLength(1);
		expect(html).toContain('<a href="/search?q=sponge" aria-label="Page 1">1</a>');
		expect(html).toContain("<title>Results for “sponge” · Page 2 · Acme Bakery</title>");

		expect((await install.request(`${SITE}/search?q=sponge&page=3`)).status).toBe(404);
		const firstPage = await install.request(`${SITE}/search?q=sponge&page=1`);
		expect(firstPage.status).toBe(301);
		expect(firstPage.headers.get("location")).toBe("/search?q=sponge");
	});
});

describe("in Edit mode", () => {
	test("the search results page shows the hits for the query too", async () => {
		const editing = await openEditMode(install, staff, siteId, "/search");

		const response = await editing.page("/search?q=brioche");

		expect(response.status).toBe(200);
		const html = await expectSafePage(response, "editMode");
		expect(hits(html)).toEqual([{ href: "/recipes/brioche", title: "Brioche" }]);
		expect(html).toContain('name="q" value="brioche"');
	});
});

describe("rate limits", () => {
	test("an IPv6 connection is counted by its /64, whichever of its addresses each search comes from", async () => {
		const network = ipv6Network();
		const from = (address: string, path: string) =>
			install.request(fromAddress(new Request(`${SITE}${path}`), address));
		for (let index = 0; index < 30; index++) {
			expect((await from(network(index + 1), `/search?q=loaf${index}`)).status).toBe(200);
		}

		expect((await from(network(31), "/search?q=brioche")).status).toBe(429);
		expect((await from(ipv6Network()(1), "/search?q=brioche")).status).toBe(200);
	});

	test("one address searches 30 times a minute; past that it is asked to wait, and others aren't", async () => {
		const busy = "198.51.100.77";
		const from = (address: string, path: string) =>
			install.request(fromAddress(new Request(`${SITE}${path}`), address));
		for (let index = 0; index < 30; index++) expect((await from(busy, `/search?q=bun${index}`)).status).toBe(200);

		const refused = await from(busy, "/search?q=brioche");
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("60");
		expect(refused.headers.get("cache-control")).toBe("no-store");
		expectSiteHeaders(refused);
		expect(await refused.text()).toBe("Too Many Requests");

		// Another address searches; the busy one still opens pages and the search box without a query.
		expect((await from("198.51.100.78", "/search?q=brioche")).status).toBe(200);
		expect((await from(busy, "/search")).status).toBe(200);
		expect((await from(busy, "/recipes/brioche?q=brioche")).status).toBe(200);

		await install.clock.advance(60_000);
		expect((await from(busy, "/search?q=brioche")).status).toBe(200);
	});
});

describe("the Search element", () => {
	test("on any page, a search box that sends visitors to the search results page with a plain GET", async () => {
		const template = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: "<header>{{@search}}</header><main>{{@outlet}}</main>",
		});
		await staff.api.templates.publish({ siteId, templateId: template.template.id });

		const html = await expectSafePage(await install.request(`${SITE}/recipes/brioche`));

		expect(html).toContain(
			'<header><form class="wc-search" role="search" method="get" action="/search"><label class="wc-visually-hidden" for="wc-search-1">Search the site</label><input class="wc-search-input" type="search" id="wc-search-1" name="q" maxlength="200" enterkeyhint="search"><button class="wc-search-button" type="submit">Search</button></form></header>',
		);
		// On the results page, the header's box is a second form, the page's content holds the search landmark.
		const results = (await search("brioche")).html;
		expect(results.match(/role="search"/g)).toHaveLength(1);
		expect(results).toContain('id="wc-search-2" name="q" value="brioche"');
	});

	test("shows nothing while the Site has no search results page", async () => {
		await staff.api.pages.setSearchPage({ siteId, pageId: null });
		try {
			const html = await expectSafePage(await install.request(`${SITE}/recipes/brioche`));
			expect(html).not.toContain("wc-search");
			// The Page is an ordinary Page again.
			const page = await install.request(`${SITE}/search?q=brioche`);
			expect(page.headers.get("cache-control")).not.toBe("no-store");
		} finally {
			await staff.api.pages.setSearchPage({ siteId, pageId: searchPageId });
		}
	});
});
