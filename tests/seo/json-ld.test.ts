// Structured data (the SEO decision): every page says what the Site is (WebSite), who is behind it
// (Organisation or Local business, from the Site's SEO settings and Globals) and where the page sits
// (breadcrumbs, from its address and parent Pages), and each Post Type describes its Entries as one
// Schema type, its properties mapped to Fields. It is JSON-LD in the page's head: data, never run, so
// it passes the Site's strict policy, and nothing in a value can break out of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { canonicalIn, headOf, jsonLdNode, jsonLdNodes } from "../harness/seo.ts";
import { expectSafePage } from "../harness/site-safety.ts";

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

type TestSite = { siteId: string; pagesId: string; origin: string };

async function newSite(): Promise<TestSite> {
	const slug = `seo-ld-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	return {
		siteId,
		pagesId: postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "",
		origin: `https://${slug}.sites.test`,
	};
}

/** A Post Type with its Entry template published. */
async function postType(
	site: TestSite,
	input: { name: string; urlPattern: string; fields?: unknown[]; seo?: Record<string, unknown> },
): Promise<string> {
	const { postType: created } = await staff.api.postTypes.create({ siteId: site.siteId, ...input } as never);
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId: site.siteId,
		postTypeId: created.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
	return created.id;
}

async function published(
	site: TestSite,
	postTypeId: string,
	input: { title: string; fields?: Record<string, unknown>; seo?: Record<string, unknown>; parentId?: string },
): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId, ...input });
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

async function page(url: string): Promise<string> {
	const response = await install.request(url);
	expect(response.status).toBe(200);
	return expectSafePage(response, "strict");
}

describe("on every page", () => {
	test("the WebSite, the organisation and the breadcrumbs to the page", async () => {
		const site = await newSite();
		const blogId = await postType(site, { name: "Blog posts", urlPattern: "/blog/{slug}" });
		const homeId = await published(site, site.pagesId, { title: "Welcome" });
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: homeId });
		await published(site, blogId, { title: "Fresh bread" });

		const html = await page(`${site.origin}/blog/fresh-bread`);

		expect(jsonLdNode(html, "WebSite")).toEqual({
			"@type": "WebSite",
			"@id": `${site.origin}/#website`,
			url: `${site.origin}/`,
			name: "Acme Bakery",
			inLanguage: "en",
			publisher: { "@id": `${site.origin}/#organization` },
		});
		expect(jsonLdNode(html, "Organization")).toEqual({
			"@type": "Organization",
			"@id": `${site.origin}/#organization`,
			name: "Acme Bakery",
			url: `${site.origin}/`,
		});
		expect(jsonLdNode(html, "BreadcrumbList")).toEqual({
			"@type": "BreadcrumbList",
			"@id": `${site.origin}/blog/fresh-bread#breadcrumb`,
			itemListElement: [
				{ "@type": "ListItem", position: 1, name: "Welcome", item: `${site.origin}/` },
				{ "@type": "ListItem", position: 2, name: "Fresh bread", item: `${site.origin}/blog/fresh-bread` },
			],
		});
		// The page itself, a Web page by default, with the Entry's title, dates and language.
		expect(jsonLdNode(html, "WebPage")).toMatchObject({
			"@id": `${site.origin}/blog/fresh-bread`,
			url: `${site.origin}/blog/fresh-bread`,
			name: "Fresh bread",
			inLanguage: "en",
			isPartOf: { "@id": `${site.origin}/#website` },
			breadcrumb: { "@id": `${site.origin}/blog/fresh-bread#breadcrumb` },
			datePublished: "2026-03-02T09:00:00.000Z",
			dateModified: "2026-03-02T09:00:00.000Z",
		});
		// One block of data in <head>.
		expect(headOf(html).match(/application\/ld\+json/g)).toHaveLength(1);
	});

	test("breadcrumbs follow the Archive page and parent Pages", async () => {
		const site = await newSite();
		const blogId = await postType(site, { name: "Blog posts", urlPattern: "/blog/{slug}" });
		const archive = await staff.api.templates.saveArchiveTemplateMarkup({
			siteId: site.siteId,
			postTypeId: blogId,
			markup: "<p>Posts</p>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: archive.template.id });
		await published(site, blogId, { title: "Rye" });
		const aboutId = await published(site, site.pagesId, { title: "About us" });
		await published(site, site.pagesId, { title: "Our team", parentId: aboutId });

		const crumbs = (html: string) =>
			((jsonLdNode(html, "BreadcrumbList")?.itemListElement ?? []) as { name: string; item: string }[]).map((item) => [
				item.name,
				item.item,
			]);

		// Without a home page, the Site's name leads to its root.
		expect(crumbs(await page(`${site.origin}/blog/rye`))).toEqual([
			["Acme Bakery", `${site.origin}/`],
			["Blog posts", `${site.origin}/blog`],
			["Rye", `${site.origin}/blog/rye`],
		]);
		expect(crumbs(await page(`${site.origin}/about-us/our-team`))).toEqual([
			["Acme Bakery", `${site.origin}/`],
			["About us", `${site.origin}/about-us`],
			["Our team", `${site.origin}/about-us/our-team`],
		]);
		const archiveHtml = await page(`${site.origin}/blog`);
		expect(crumbs(archiveHtml)).toEqual([
			["Acme Bakery", `${site.origin}/`],
			["Blog posts", `${site.origin}/blog`],
		]);
		expect(jsonLdNode(archiveHtml, "CollectionPage")).toMatchObject({
			"@id": `${site.origin}/blog`,
			name: "Blog posts",
		});
	});

	test("the organisation comes from the Site's SEO settings and Globals, as a Local business when it is one", async () => {
		const site = await newSite();
		await staff.api.globals.setFields({
			siteId: site.siteId,
			fields: [
				{ key: "phone", label: "Phone", type: "text" },
				{ key: "address", label: "Address", type: "text" },
			],
		});
		await editor.api.globals.saveDraft({
			siteId: site.siteId,
			fields: { phone: "+353 21 555 0100", address: "1 Harbour Street, Cork" },
		});
		await editor.api.globals.publish({ siteId: site.siteId });
		const bytes = await photo({ width: 600, height: 600, format: "png" });
		const { media: logo } = await editor.api.media.upload({ siteId: site.siteId, file: upload(bytes, "logo.png") });
		await install.drainJobs();
		await staff.api.seoSettings.update({
			siteId: site.siteId,
			siteName: "Acme Bakery Cork",
			organization: {
				kind: "localBusiness",
				name: "Acme Bakery Ltd",
				logo: logo.id,
				sameAs: ["https://social.example/acmebakery"],
				telephone: "phone",
				address: "address",
			},
		});
		const blogId = await postType(site, { name: "Blog posts", urlPattern: "/blog/{slug}" });
		await published(site, blogId, { title: "Opening hours" });

		const html = await page(`${site.origin}/blog/opening-hours`);

		expect(jsonLdNode(html, "WebSite")?.name).toBe("Acme Bakery Cork");
		expect(jsonLdNode(html, "LocalBusiness")).toEqual({
			"@type": "LocalBusiness",
			"@id": `${site.origin}/#organization`,
			name: "Acme Bakery Ltd",
			url: `${site.origin}/`,
			logo: {
				"@type": "ImageObject",
				url: expect.stringMatching(new RegExp(`^${site.origin}/_media/[0-9a-f]{16}-logo\\.png$`)),
				width: 600,
				height: 600,
			},
			sameAs: ["https://social.example/acmebakery"],
			telephone: "+353 21 555 0100",
			address: "1 Harbour Street, Cork",
		});
	});

	test("a Site with a search results page tells search engines how to search it", async () => {
		const site = await newSite();
		const searchId = await published(site, site.pagesId, { title: "Search" });
		await staff.api.pages.setSearchPage({ siteId: site.siteId, pageId: searchId });
		const aboutId = await published(site, site.pagesId, { title: "About" });

		const html = await page(`${site.origin}/about`);

		expect(aboutId).toBeTruthy();
		expect(jsonLdNode(html, "WebSite")?.potentialAction).toEqual({
			"@type": "SearchAction",
			target: { "@type": "EntryPoint", urlTemplate: `${site.origin}/search?q={search_term_string}` },
			"query-input": "required name=search_term_string",
		});
	});

	test("the 404 page says what the Site is, and nothing about a page that isn't there", async () => {
		const site = await newSite();
		const response = await install.request(`${site.origin}/missing`);
		const html = await response.text();

		expect(jsonLdNodes(html).map((node) => node["@type"])).toEqual(["WebSite", "Organization"]);
	});
});

describe("Schema types", () => {
	test("choosing a type maps its properties to WebCraft's guesses: the title, the author, the dates, the image", async () => {
		const site = await newSite();
		const bytes = await photo({ width: 1600, height: 900, format: "jpeg" });
		const { media: cover } = await editor.api.media.upload({ siteId: site.siteId, file: upload(bytes, "cover.jpg") });
		await install.drainJobs();
		const blogId = await postType(site, {
			name: "Blog posts",
			urlPattern: "/blog/{slug}",
			fields: [
				{ key: "cover", label: "Cover", type: "media" },
				{ key: "summary", label: "Summary", type: "richText" },
				{ key: "tags", label: "Tags", type: "select", multiple: true, options: [{ value: "rye", label: "Rye" }] },
			],
		});
		const { postType: updated } = await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: blogId,
			seo: { schema: { type: "blogPosting" }, descriptionField: "summary" },
		});
		expect(updated.seo.schema).toEqual({
			type: "blogPosting",
			properties: {
				headline: "title",
				description: "seo.description",
				image: "seo.image",
				author: "author",
				datePublished: "publishedAt",
				dateModified: "lastPublishedAt",
				keywords: "tags",
			},
		});
		await published(site, blogId, {
			title: "Dark rye",
			fields: { cover: cover.id, summary: "<p>Heavy, <em>sour</em> and good.</p>", tags: ["rye"] },
		});

		const html = await page(`${site.origin}/blog/dark-rye`);

		const post = jsonLdNode(html, "BlogPosting");
		expect(post).toMatchObject({
			"@id": `${site.origin}/blog/dark-rye#blogposting`,
			mainEntityOfPage: { "@id": `${site.origin}/blog/dark-rye` },
			headline: "Dark rye",
			description: "Heavy, sour and good.",
			author: { "@type": "Person", name: expect.any(String) },
			datePublished: "2026-03-02T09:00:00.000Z",
			dateModified: "2026-03-02T09:00:00.000Z",
			keywords: "Rye",
			publisher: { "@id": `${site.origin}/#organization` },
			inLanguage: "en",
		});
		expect(((post?.image ?? {}) as { url?: string }).url).toMatch(
			new RegExp(`^${site.origin}/_media/[0-9a-f]{16}-cover-1280\\.webp$`),
		);
		// An article is shared as one.
		expect(headOf(html)).toContain('<meta property="og:type" content="article">');
	});

	test("Staff map properties to Fields: an Event's dates, place and price", async () => {
		const site = await newSite();
		const eventsId = await postType(site, {
			name: "Events",
			urlPattern: "/events/{slug}",
			fields: [
				{ key: "starts", label: "Starts", type: "date", mode: "dateTime" },
				{ key: "ends", label: "Ends", type: "date", mode: "dateTime" },
				{ key: "venue", label: "Venue", type: "text" },
				{ key: "price", label: "Price", type: "number" },
			],
			seo: { schema: { type: "event" } },
		});
		const { postType: guessed } = await staff.api.postTypes.get({ siteId: site.siteId, postTypeId: eventsId });
		// Guessed from the Fields' names.
		expect(guessed.seo.schema.properties).toMatchObject({
			startDate: "starts",
			endDate: "ends",
			location: "venue",
			"offers.price": "price",
		});
		await published(site, eventsId, {
			title: "Bread masterclass",
			fields: { starts: "2026-04-11T10:00:00Z", ends: "2026-04-11T13:00:00Z", venue: "The bakehouse", price: 45 },
		});

		const event = jsonLdNode(await page(`${site.origin}/events/bread-masterclass`), "Event");

		expect(event).toMatchObject({
			name: "Bread masterclass",
			startDate: "2026-04-11T10:00:00.000Z",
			endDate: "2026-04-11T13:00:00.000Z",
			location: { "@type": "Place", name: "The bakehouse" },
			offers: { "@type": "Offer", price: 45 },
		});
	});

	test("an FAQ page lists a Repeater's rows as its questions and answers", async () => {
		const site = await newSite();
		const faqId = await postType(site, {
			name: "Help",
			urlPattern: "/help/{slug}",
			fields: [
				{
					key: "faqs",
					label: "Questions",
					type: "repeater",
					fields: [
						{ key: "question", label: "Question", type: "text" },
						{ key: "answer", label: "Answer", type: "richText" },
					],
				},
			],
			seo: { schema: { type: "faqPage" } },
		});
		await published(site, faqId, {
			title: "Ordering",
			fields: {
				faqs: [
					{ question: "Can I order a cake?", answer: "<p>Yes, <strong>48 hours</strong> ahead.</p>" },
					{ question: "Do you deliver?", answer: "<p>Within Cork city.</p>" },
				],
			},
		});

		const faq = jsonLdNode(await page(`${site.origin}/help/ordering`), "FAQPage");

		expect(faq).toMatchObject({
			"@id": `${site.origin}/help/ordering`,
			name: "Ordering",
			mainEntity: [
				{
					"@type": "Question",
					name: "Can I order a cake?",
					acceptedAnswer: { "@type": "Answer", text: "Yes, 48 hours ahead." },
				},
				{
					"@type": "Question",
					name: "Do you deliver?",
					acceptedAnswer: { "@type": "Answer", text: "Within Cork city." },
				},
			],
		});
	});

	test("an author linked to a Person Entry is that person, with their page", async () => {
		const site = await newSite();
		const peopleId = await postType(site, {
			name: "People",
			urlPattern: "/people/{slug}",
			seo: { schema: { type: "person" } },
		});
		const recipesId = await postType(site, {
			name: "Recipes",
			urlPattern: "/recipes/{slug}",
			fields: [
				{ key: "chef", label: "Chef", type: "relationship", postTypes: ["people"] },
				{
					key: "ingredients",
					label: "Ingredients",
					type: "repeater",
					fields: [{ key: "item", label: "Item", type: "text" }],
				},
			],
		});
		await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: recipesId,
			seo: {
				schema: { type: "recipe", properties: { name: "title", author: "chef", recipeIngredient: "ingredients.item" } },
			},
		});
		const aoifeId = await published(site, peopleId, { title: "Aoife Kelly" });
		await published(site, recipesId, {
			title: "Soda bread",
			fields: { chef: aoifeId, ingredients: [{ item: "Buttermilk" }, { item: "Wholemeal flour" }] },
		});

		const recipe = jsonLdNode(await page(`${site.origin}/recipes/soda-bread`), "Recipe");

		expect(recipe).toMatchObject({
			name: "Soda bread",
			author: { "@type": "Person", name: "Aoife Kelly", url: `${site.origin}/people/aoife-kelly` },
			recipeIngredient: ["Buttermilk", "Wholemeal flour"],
		});
		// Only what Staff mapped.
		expect(recipe).not.toHaveProperty("description");
	});
});

describe("safety", () => {
	test("nothing in a value can end the block or be read as markup, and values are plain text", async () => {
		const site = await newSite();
		const blogId = await postType(site, { name: "Blog posts", urlPattern: "/blog/{slug}" });
		const title = 'Rolls </script><script>alert("x")</script> & <!-- done';
		const description = "Line\u2028and paragraph\u2029separators </script>";
		const entryId = await published(site, blogId, { title, seo: { title: "Safe", description } });
		const { entry } = await staff.api.entries.get({ siteId: site.siteId, entryId });

		const html = await page(`${site.origin}${entry.path}`);

		const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
		expect(block).not.toContain("<");
		expect(block).not.toContain(">");
		expect(block).not.toContain("&");
		expect(block).not.toContain("\u2028");
		expect(block).not.toContain("\u2029");
		// Read back, the values are exactly what was written.
		expect(jsonLdNode(html, "WebPage")?.name).toBe(title);
		expect(jsonLdNode(html, "WebPage")?.description).toBe(description);
		expect(canonicalIn(html)).toBe(`${site.origin}${entry.path}`);
	});
});
