// Markdown copies (spec story 118): every indexable Entry's page has a copy in Markdown at its address
// plus `.md` (the home page at `/index.html.md`), for AI engines to read cleanly: its title, Summary,
// the Fields a reader needs and its Body field Block by Block, every text escaped, every address
// absolute, never any HTML, and a `Link` header naming the page's canonical URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";
import { goLive, openStaging } from "../harness/staging.ts";

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

type TestSite = {
	siteId: string;
	slug: string;
	recipesId: string;
	categoriesId: string;
	pagesId: string;
	origin: string;
};

/** A live Site with recipes (a Field of every kind and a Body field) and categories they point at. */
async function newSite(languages: string[] = []): Promise<TestSite> {
	const slug = `markdown-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postType: categories } = await staff.api.postTypes.create({
		siteId,
		name: "Categories",
		key: "categories",
		urlPattern: "/categories/{slug}",
	});
	const { postType: recipes } = await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		summaryField: "summary",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "serves", label: "Serves", type: "number" },
			{
				key: "difficulty",
				label: "Difficulty",
				type: "select",
				options: [
					{ value: "easy", label: "Easy" },
					{ value: "hard", label: "Hard" },
				],
			},
			{ key: "source", label: "Source", type: "link" },
			{ key: "contact", label: "Contact", type: "email" },
			{ key: "category", label: "Category", type: "relationship", postTypes: ["categories"] },
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "vegan", label: "Vegan", type: "boolean" },
			{ key: "details", label: "Details", type: "group", fields: [{ key: "origin", label: "Origin", type: "text" }] },
			{
				key: "steps",
				label: "Steps",
				type: "repeater",
				fields: [
					{ key: "text", label: "Text", type: "text" },
					{ key: "minutes", label: "Minutes", type: "number" },
				],
			},
			{ key: "body", label: "Body", type: "body" },
		],
	});
	for (const postType of [categories, recipes]) {
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: "<h1>{{ title }}</h1>",
		});
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	}
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	return {
		siteId,
		slug,
		recipesId: recipes.id,
		categoriesId: categories.id,
		pagesId: postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "",
		origin,
	};
}

async function published(site: TestSite, postTypeId: string, input: Record<string, unknown>): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId, ...input } as never);
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

async function copy(url: string): Promise<{ response: Response; text: string }> {
	const response = await install.request(url);
	return { response, text: await response.text() };
}

describe("a copy", () => {
	test("holds the title, Summary, the Fields a reader needs and the body Block by Block, escaped", async () => {
		const site = await newSite();
		const breads = await published(site, site.categoriesId, { title: "Breads" });
		await published(site, site.recipesId, {
			title: "Sourdough <tag> & co",
			fields: {
				summary: "Slow, *crusty* loaf.",
				serves: 4,
				difficulty: "easy",
				source: { url: "/about", text: "Grandma's book" },
				contact: "baker@acme.example",
				category: breads,
				vegan: true,
				details: { origin: "Galway" },
				steps: [
					{ text: "Mix", minutes: 10 },
					{ text: "Bake", minutes: 40 },
				],
				body: [
					{ type: "heading", level: 2, text: "Before you start" },
					{
						type: "paragraph",
						text: [
							{ text: "Use " },
							{ text: "strong", marks: ["bold"] },
							{ text: " flour, see " },
							{ text: "the guide", link: "/guides/flour" },
							{ text: " or " },
							{ text: "below", link: "#steps" },
							{ text: ".\nThen rest." },
						],
					},
					{ type: "list", style: "bulleted", items: ["Flour", { text: "Water", items: ["Warm"] }] },
					{ type: "list", style: "numbered", items: ["Mix", "Bake"] },
					{ type: "quote", text: "Bread is life <3 & more" },
					{
						type: "table",
						rows: [
							["Step", "Time"],
							["Rise | prove", "8 h"],
						],
					},
					{ type: "code", code: "const a = `x`;", language: "js" },
					{ type: "divider" },
					{ type: "toggle", summary: "Why?", text: "Because." },
					{ type: "callout", tone: "warning", text: "Preheat *the* oven" },
					{ type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "How to knead" },
					{ type: "paragraph", text: "<script>alert(1)</script>" },
				],
			},
		});

		const { response, text } = await copy(`${site.origin}/recipes/sourdough-tag-co.md`);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		expect(response.headers.get("link")).toBe(`<${site.origin}/recipes/sourdough-tag-co>; rel="canonical"`);
		expectSiteHeaders(response);
		const page = `${site.origin}/recipes/sourdough-tag-co`;
		expect(text).toBe(
			[
				"# Sourdough \\<tag\\> \\& co",
				"",
				"> Slow, \\*crusty\\* loaf.",
				"",
				"- **Serves:** 4",
				"- **Difficulty:** Easy",
				`- **Source:** [Grandma's book](${site.origin}/about)`,
				"- **Contact:** [baker@acme.example](mailto:baker@acme.example)",
				`- **Category:** [Breads](${site.origin}/categories/breads)`,
				"- **Details:**",
				"  - **Origin:** Galway",
				"- **Steps:**",
				"  1. **Text:** Mix; **Minutes:** 10",
				"  2. **Text:** Bake; **Minutes:** 40",
				"",
				"## Before you start",
				"",
				`Use **strong** flour, see [the guide](${site.origin}/guides/flour) or [below](${page}#steps).\\`,
				"Then rest.",
				"",
				"- Flour",
				"- Water",
				"  - Warm",
				"",
				"1. Mix",
				"2. Bake",
				"",
				"> Bread is life \\<3 \\& more",
				"",
				"| Step | Time |",
				"| --- | --- |",
				"| Rise \\| prove | 8 h |",
				"",
				"```js",
				"const a = `x`;",
				"```",
				"",
				"---",
				"",
				"**Why?**",
				"",
				"Because.",
				"",
				"> Preheat \\*the\\* oven",
				"",
				"[How to knead](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
				"",
				"\\<script\\>alert(1)\\</script\\>",
				"",
			].join("\n"),
		);
	});

	test("resolves a link with no scheme against the page's own address, as a browser would", async () => {
		const site = await newSite();
		await published(site, site.recipesId, {
			title: "Bread",
			fields: {
				source: { url: "about", text: "About us" },
				body: [{ type: "paragraph", text: [{ text: "the team", link: "../team" }] }],
			},
		});

		const { text } = await copy(`${site.origin}/recipes/bread.md`);

		expect(text).toContain(`- **Source:** [About us](${site.origin}/recipes/about)`);
		expect(text).toContain(`[the team](${site.origin}/team)`);
	});

	test("shows Media images at their absolute address with their alt text in the page's language", async () => {
		const site = await newSite();
		const bytes = await photo({ width: 800, height: 600, format: "jpeg" });
		const { media } = await editor.api.media.upload({ siteId: site.siteId, file: upload(bytes, "loaf.jpg") });
		await install.drainJobs();
		await editor.api.media.update({ siteId: site.siteId, mediaId: media.id, alt: "A [round] loaf", caption: "Fresh" });
		await published(site, site.recipesId, {
			title: "Rye",
			fields: { photo: media.id, body: [{ type: "image", media: media.id }] },
		});

		const { text } = await copy(`${site.origin}/recipes/rye.md`);

		const image = /!\[A \\\[round\\\] loaf\]\((https:\/\/[^)]+)\)/.exec(text);
		expect(image?.[1]).toStartWith(`${site.origin}/_media/`);
		expect(text).toContain(`- **Photo:** ![A \\[round\\] loaf](${image?.[1]})`);
		expect(text).toContain(`![A \\[round\\] loaf](${image?.[1]})\n\n*Fresh*`);
		expect((await install.request(image?.[1] ?? "")).status).toBe(200);
	});

	test("names the canonical URL the Entry gives, as its page's head does", async () => {
		const site = await newSite();
		await published(site, site.recipesId, { title: "Syndicated", seo: { canonical: "https://news.example/bread" } });
		await published(site, site.recipesId, { title: "Abroad", seo: { canonical: "https://news.example/pâtisserie" } });

		const { response } = await copy(`${site.origin}/recipes/syndicated.md`);
		const abroad = await copy(`${site.origin}/recipes/abroad.md`);

		expect(response.status).toBe(200);
		expect(response.headers.get("link")).toBe('<https://news.example/bread>; rel="canonical"');
		// A header carries ASCII only: international letters are percent-encoded.
		expect(abroad.response.headers.get("link")).toBe('<https://news.example/p%C3%A2tisserie>; rel="canonical"');
	});
});

describe("addresses", () => {
	test("Pages at their path plus .md; the home page at /index.html.md, and at its language's root plus .md", async () => {
		const site = await newSite(["fr"]);
		const home = await published(site, site.pagesId, { title: "Welcome" });
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: home });
		await published(site, site.pagesId, { title: "About" });

		expect((await copy(`${site.origin}/index.html.md`)).text).toBe("# Welcome\n");
		expect((await copy(`${site.origin}/fr.md`)).text).toBe("# Welcome\n");
		expect((await copy(`${site.origin}/about.md`)).text).toBe("# About\n");
		expect((await copy(`${site.origin}/fr/about.md`)).response.status).toBe(200);
		// The home page's own path goes to the root's copy, as the page goes to the root.
		const own = await install.request(`${site.origin}/welcome.md`);
		expect(own.status).toBe(301);
		expect(own.headers.get("location")).toBe(`${site.origin}/index.html.md`);
		for (const path of ["/index.md", "/about/.md", "/.md", "/about.md.md"]) {
			expect((await install.request(`${site.origin}${path}`)).status, path).toBe(404);
		}
	});

	test("a language on its own domain has its copies there; its prefix on the Primary domain goes there", async () => {
		const site = await newSite(["fr"]);
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.recipesId,
			title: "Bread",
		});
		await editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: entry.id,
			language: "fr",
			title: "Pain",
			slug: "pain",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await staff.api.languages.update({ siteId: site.siteId, code: "fr", domain: `${site.slug}.fr` });
		install.connectDomain(`${site.slug}.fr`);
		await install.clock.advance(60_000);
		expect((await install.drainJobs()).failed).toEqual([]);

		const french = await copy(`https://${site.slug}.fr/recipes/pain.md`);
		expect(french.text).toBe("# Pain\n");
		expect(french.response.headers.get("link")).toBe(`<https://${site.slug}.fr/recipes/pain>; rel="canonical"`);
		const moved = await install.request(`${site.origin}/fr/recipes/pain.md`);
		expect(moved.status).toBe(301);
		expect(moved.headers.get("location")).toBe(`https://${site.slug}.fr/recipes/pain.md`);
	});
});

describe("no copy", () => {
	test("for a noindex Entry, one hidden in the language, a Draft, an Archive page, the 404 and search results pages", async () => {
		const site = await newSite(["fr"]);
		await published(site, site.recipesId, { title: "Staff only", seo: { noindex: true } });
		await published(site, site.recipesId, { title: "English only", hiddenLanguages: ["fr"] });
		await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.recipesId, title: "Not yet" });
		const saved = await staff.api.templates.saveArchiveTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.recipesId,
			markup: "<h1>Recipes</h1>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
		const missing = await published(site, site.pagesId, { title: "Missing" });
		const search = await published(site, site.pagesId, { title: "Search" });
		await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: missing });
		await staff.api.pages.setSearchPage({ siteId: site.siteId, pageId: search });

		for (const path of [
			"/recipes/staff-only.md",
			"/fr/recipes/english-only.md",
			"/recipes/not-yet.md",
			"/recipes.md",
			"/missing.md",
			"/search.md",
		]) {
			const response = await install.request(`${site.origin}${path}`);
			expect(response.status, path).toBe(404);
			expect(response.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
		}
		expect((await copy(`${site.origin}/recipes/english-only.md`)).response.status).toBe(200);
	});

	test("on the Staging address, even for the people reviewing it", async () => {
		const site = await newSite();
		await published(site, site.recipesId, { title: "Bread" });
		const reviewer = await openStaging(install, staff, site.siteId);

		expect((await reviewer.page("/recipes/bread.md")).status).toBe(404);
	});
});

describe("kept in the page cache", () => {
	test("until a publish", async () => {
		const site = await newSite();
		const entryId = await published(site, site.recipesId, { title: "Bread" });
		expect((await copy(`${site.origin}/recipes/bread.md`)).response.headers.get("x-cache")).toBe("MISS");
		expect((await copy(`${site.origin}/recipes/bread.md`)).response.headers.get("x-cache")).toBe("HIT");

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, fields: { summary: "Fresh." } });
		expect((await copy(`${site.origin}/recipes/bread.md`)).text).toBe("# Bread\n");
		await editor.api.entries.publish({ siteId: site.siteId, entryId });

		const after = await copy(`${site.origin}/recipes/bread.md`);
		expect(after.response.headers.get("x-cache")).toBe("MISS");
		expect(after.text).toBe("# Bread\n\n> Fresh.\n");
	});
});
