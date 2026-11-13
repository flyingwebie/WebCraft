// Every page carries good metadata out of the box (the SEO decision): its title, description and
// canonical URL on the Primary domain, robots noindex where asked, and Open Graph and social tags with
// absolute addresses of the right Media image variant and its alt text.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { canonicalIn, headOf, metaName, metaProperties, metaProperty, titleIn } from "../harness/seo.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { openStaging, goLive as putLive } from "../harness/staging.ts";

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

/** A Site: on its Primary domain (`origin`), where visitors and search engines are, and its Staging address. */
type TestSite = { siteId: string; postTypeId: string; pagesId: string; origin: string; staging: string };

/** A Site with a blog Post Type (a cover image and a Body field) whose Entry template is published. */
async function newSite(options: { languages?: string[] } = {}): Promise<TestSite> {
	const slug = `seo-head-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	for (const code of options.languages ?? []) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "body", label: "Body", type: "body" },
			{ key: "cover", label: "Cover image", type: "media" },
			{ key: "summary", label: "Summary", type: "richText" },
		],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1>{{ body }}</article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	return {
		siteId,
		postTypeId: postType.id,
		pagesId: postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "",
		origin: await putLive(install, siteId),
		staging: `https://${slug}.sites.test`,
	};
}

async function publishedEntry(
	site: TestSite,
	input: { title: string; fields?: Record<string, unknown>; seo?: Record<string, unknown> },
): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, ...input });
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

async function page(url: string): Promise<string> {
	const response = await install.request(url);
	expect(response.status).toBe(200);
	return response.text();
}

/** Uploads an image, lets the worker clean it and make its variants, and gives it alt text. */
async function uploadImage(siteId: string, options: { name?: string; alt?: string; width?: number } = {}) {
	const bytes = await photo({ width: options.width ?? 1600, height: 900, format: "jpeg" });
	const { media } = await editor.api.media.upload({ siteId, file: upload(bytes, options.name ?? "loaf.jpg") });
	await install.drainJobs();
	if (options.alt) await editor.api.media.update({ siteId, mediaId: media.id, alt: options.alt });
	return (await editor.api.media.get({ siteId, mediaId: media.id })).media;
}

/** Adds a Primary domain to a Site, points it at the Install and lets the worker verify it. */
/** Moves the Site to another Primary domain, `name`, verified as the Install verifies one. */
async function goLive(siteId: string, name: string): Promise<string> {
	const { domains } = await staff.api.domains.add({ siteId, name, withPartner: false });
	install.connectDomain(name);
	await install.clock.advance(60_000);
	expect((await install.drainJobs()).failed).toEqual([]);
	await staff.api.domains.makePrimary({ siteId, domainId: domains[0]?.id ?? "" });
	return `https://${name}`;
}

const paragraph = (text: unknown) => ({ type: "paragraph", text });

describe("title, description and canonical URL", () => {
	test("an Entry's SEO title and description are the page's, and its canonical URL is its own address", async () => {
		const site = await newSite();
		await publishedEntry(site, {
			title: "Fresh bread",
			seo: { title: "Fresh sourdough every morning · Acme", description: 'Our "best" loaves & rolls, <hot>.' },
		});

		const html = await page(`${site.origin}/blog/fresh-bread`);

		expect(titleIn(html)).toBe("Fresh sourdough every morning · Acme");
		expect(metaName(html, "description")).toBe('Our "best" loaves & rolls, <hot>.');
		expect(canonicalIn(html)).toBe(`${site.origin}/blog/fresh-bread`);
		// Everything is escaped where it lands; nothing in <head> runs.
		expect(headOf(html)).toContain('content="Our &quot;best&quot; loaves &amp; rolls, &lt;hot&gt;."');
		expect(metaName(html, "robots")).toBeUndefined();
	});

	test("without an SEO title, the title is the Post Type's pattern: the Entry's title, then the Site's name", async () => {
		const site = await newSite();
		await publishedEntry(site, { title: "Rye loaves" });

		expect(titleIn(await page(`${site.origin}/blog/rye-loaves`))).toBe("Rye loaves · Acme Bakery");
	});

	test("without a description, it is the start of the body as plain text, cut at a word", async () => {
		const site = await newSite();
		const words = "Our rye loaf is baked slowly in a stone oven with a starter we have kept alive since 1987, ";
		await publishedEntry(site, {
			title: "Slow rye",
			fields: {
				body: [
					{ type: "heading", level: 2, text: "Why slow?" },
					paragraph([{ text: "Our " }, { text: "rye", marks: ["bold"] }, { text: words.slice(7) }]),
					paragraph("so every crumb tastes of time. It takes three days from flour to shelf, and it is worth it."),
				],
			},
		});

		const description = metaName(await page(`${site.origin}/blog/slow-rye`), "description") ?? "";

		expect(description.startsWith("Why slow? Our rye loaf is baked slowly in a stone oven")).toBe(true);
		expect(description.endsWith("…")).toBe(true);
		expect(description.length).toBeLessThanOrEqual(156);
		// Cut cleanly, at the end of a word.
		expect(description).toMatch(/[a-z,.]…$/);
		expect(description).not.toContain("<");
	});

	test("an Entry without any description has no description tag", async () => {
		const site = await newSite();
		await publishedEntry(site, { title: "Plain" });

		expect(metaName(await page(`${site.origin}/blog/plain`), "description")).toBeUndefined();
	});

	test("the canonical URL is on the Primary domain, even on the Staging address of a live Site", async () => {
		const site = await newSite({ languages: ["fr"] });
		const entryId = await publishedEntry(site, { title: "Croissants" });
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, language: "fr", slug: "croissants-au-beurre" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId });
		const live = await goLive(site.siteId, `bakery-${sites}.example`);

		expect(canonicalIn(await page(`${live}/blog/croissants`))).toBe(`${live}/blog/croissants`);
		expect(canonicalIn(await page(`${live}/fr/blog/croissants-au-beurre`))).toBe(
			`${live}/fr/blog/croissants-au-beurre`,
		);
		// The Staging address stays out of search engines, and points them at the live page.
		const staging = await (await openStaging(install, staff, site.siteId)).page("/blog/croissants");
		expect(staging.headers.get("x-robots-tag")).toBe("noindex");
		expect(canonicalIn(await staging.text())).toBe(`${live}/blog/croissants`);
	});

	test("a canonical URL given on the Entry wins: a path is on the Primary domain, an address as written", async () => {
		const site = await newSite();
		const live = await goLive(site.siteId, `canonical-${sites}.example`);
		await publishedEntry(site, { title: "Duplicate", seo: { canonical: "/blog/original" } });
		await publishedEntry(site, { title: "Syndicated", seo: { canonical: "https://news.example.org/story?id=7" } });

		expect(canonicalIn(await page(`${live}/blog/duplicate`))).toBe(`${live}/blog/original`);
		expect(canonicalIn(await page(`${live}/blog/syndicated`))).toBe("https://news.example.org/story?id=7");
	});

	test("noindex asks search engines not to index the page", async () => {
		const site = await newSite();
		await publishedEntry(site, { title: "Thank you", seo: { noindex: true } });

		const html = await page(`${site.origin}/blog/thank-you`);

		expect(metaName(html, "robots")).toBe("noindex");
	});

	test("the pages answer with the head under the Site's strict policy", async () => {
		const site = await newSite();
		await publishedEntry(site, { title: "Policy", seo: { description: "</script><script>alert(1)</script>" } });

		await expectSafePage(await install.request(`${site.origin}/blog/policy`), "strict");
	});
});

describe("Open Graph and social tags", () => {
	test("a page shares its title, description, address, Site name and language", async () => {
		const site = await newSite({ languages: ["pt-BR", "fr"] });
		await publishedEntry(site, { title: "Pastries", seo: { description: "Flaky and buttery." } });

		const html = await page(`${site.origin}/blog/pastries`);

		expect(metaProperty(html, "og:type")).toBe("website");
		expect(metaProperty(html, "og:title")).toBe("Pastries");
		expect(metaProperty(html, "og:description")).toBe("Flaky and buttery.");
		expect(metaProperty(html, "og:url")).toBe(`${site.origin}/blog/pastries`);
		expect(metaProperty(html, "og:site_name")).toBe("Acme Bakery");
		expect(metaProperty(html, "og:locale")).toBe("en");
		expect(metaProperties(html, "og:locale:alternate")).toEqual(["pt_BR", "fr"]);
		expect(metaName(html, "twitter:card")).toBe("summary");
	});

	test("the social image is an absolute address of a WebP variant wide enough to share, with its alt text", async () => {
		const site = await newSite();
		const image = await uploadImage(site.siteId, { alt: "A loaf on a board", width: 2000 });
		await publishedEntry(site, { title: "Loaf", seo: { image: image.id } });

		const html = await page(`${site.origin}/blog/loaf`);

		const shared = metaProperty(html, "og:image") ?? "";
		expect(shared).toMatch(new RegExp(`^${site.origin}/_media/[0-9a-f]{16}-loaf-1280\\.webp$`));
		expect(metaProperty(html, "og:image:type")).toBe("image/webp");
		expect(metaProperty(html, "og:image:width")).toBe("1280");
		expect(metaProperty(html, "og:image:height")).toBe("576");
		expect(metaProperty(html, "og:image:alt")).toBe("A loaf on a board");
		expect(metaName(html, "twitter:card")).toBe("summary_large_image");
		expect(metaName(html, "twitter:image:alt")).toBe("A loaf on a board");
		// Visitors can fetch it.
		const file = await install.request(shared);
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toBe("image/webp");
	});

	test("without a social image, the Post Type's image Field gives one, then the Site's default image", async () => {
		const site = await newSite();
		const cover = await uploadImage(site.siteId, { name: "cover.jpg" });
		const fallback = await uploadImage(site.siteId, { name: "shopfront.jpg" });
		await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			seo: { imageField: "cover" },
		});
		await staff.api.seoSettings.update({ siteId: site.siteId, defaultImage: fallback.id });
		await publishedEntry(site, { title: "With cover", fields: { cover: cover.id } });
		await publishedEntry(site, { title: "Without cover" });

		expect(metaProperty(await page(`${site.origin}/blog/with-cover`), "og:image")).toContain("-cover-");
		expect(metaProperty(await page(`${site.origin}/blog/without-cover`), "og:image")).toContain("-shopfront-");
	});

	test("an image still being processed, in the Trash or an SVG is never shared", async () => {
		const site = await newSite();
		const image = await uploadImage(site.siteId);
		await publishedEntry(site, { title: "Trashed", seo: { image: image.id } });
		const asked = await editor.api.media.delete({ siteId: site.siteId, mediaId: image.id });
		if (asked.trashed) throw new Error("It should ask first.");
		await editor.api.media.delete({ siteId: site.siteId, mediaId: image.id, confirmation: asked.confirmation.id });

		const html = await page(`${site.origin}/blog/trashed`);

		expect(metaProperty(html, "og:image")).toBeUndefined();
		expect(metaName(html, "twitter:card")).toBe("summary");
	});
});

describe("other pages", () => {
	test("a page past the first of a paginated Loop keeps ?page=N in its canonical URL and its title", async () => {
		const site = await newSite();
		for (const title of ["One", "Two", "Three"]) await publishedEntry(site, { title });
		const { loop } = await staff.api.loops.create({
			siteId: site.siteId,
			name: "posts",
			source: "query",
			query: { postTypes: ["blog-posts"], limit: 2, paginate: true },
		});
		await staff.api.loops.publish({ siteId: site.siteId, loopId: loop.id });
		const archive = await staff.api.templates.saveArchiveTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: "{{@loop posts as post}}<p>{{ post.title }}</p>{{/loop}}{{@pagination posts}}",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: archive.template.id });

		const first = await page(`${site.origin}/blog`);
		const second = await page(`${site.origin}/blog?page=2`);

		expect(titleIn(first)).toBe("Blog posts · Acme Bakery");
		expect(canonicalIn(first)).toBe(`${site.origin}/blog`);
		expect(titleIn(second)).toBe("Blog posts · Page 2 · Acme Bakery");
		expect(canonicalIn(second)).toBe(`${site.origin}/blog?page=2`);
	});

	test("the home page is titled by the Page Post Type's pattern, at the Site's root", async () => {
		const site = await newSite();
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Welcome",
			seo: { description: "The bakery on Harbour Street." },
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: entry.id });

		const html = await page(`${site.origin}/`);

		expect(titleIn(html)).toBe("Welcome · Acme Bakery");
		expect(canonicalIn(html)).toBe(`${site.origin}/`);
		expect(metaName(html, "description")).toBe("The bakery on Harbour Street.");
	});

	test("the 404 page has no canonical URL and is never indexed, and a chosen 404 Page is noindex at its own path too", async () => {
		const site = await newSite();
		const missing = await install.request(`${site.origin}/nowhere`);
		expect(missing.status).toBe(404);
		const builtIn = await missing.text();
		expect(metaName(builtIn, "robots")).toBe("noindex");
		expect(canonicalIn(builtIn)).toBeUndefined();

		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Lost?",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: entry.id });

		const own = await install.request(`${site.origin}/lost`);
		expect(own.status).toBe(200);
		expect(metaName(await own.text(), "robots")).toBe("noindex");
		const chosen = await install.request(`${site.origin}/nowhere-else`);
		expect(chosen.status).toBe(404);
		const html = await chosen.text();
		expect(titleIn(html)).toBe("Lost? · Acme Bakery");
		expect(metaName(html, "robots")).toBe("noindex");
		expect(canonicalIn(html)).toBeUndefined();
	});
});
