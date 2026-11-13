// llms.txt (spec story 118): each language of a Site answers one at its own address (`/llms.txt`,
// `/fr/llms.txt`, or `/llms.txt` on a language's domain): the Site's name and description, then the
// indexable Entries of each Post Type with their title, the address of their Markdown copy and what
// they are about. It lists what the sitemaps list, by the same rule.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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

type TestSite = { siteId: string; slug: string; blogId: string; pagesId: string; origin: string };

async function newSite(languages: string[] = []): Promise<TestSite> {
	const slug = `llms-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "blog",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "body", label: "Body", type: "body" },
		],
		summaryField: "summary",
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

async function published(site: TestSite, postTypeId: string, input: Record<string, unknown>): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId, ...input } as never);
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	await install.clock.advance(1_000);
	return entry.id;
}

async function llms(url: string): Promise<string> {
	const response = await install.request(url);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	expectSiteHeaders(response);
	return response.text();
}

describe("llms.txt", () => {
	test("names the Site and lists each Post Type's Entries, newest first, with their Markdown copies", async () => {
		const site = await newSite();
		const home = await published(site, site.pagesId, {
			title: "Welcome",
			seo: { description: "Bread baked daily in Galway." },
		});
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: home });
		await published(site, site.pagesId, { title: "About" });
		await published(site, site.blogId, { title: "Fresh bread", fields: { summary: "Why we bake at dawn." } });
		await published(site, site.blogId, {
			title: "Rye [dark] *loaves*",
			fields: { body: [{ type: "paragraph", text: "Rye takes three days, and it is worth it." }] },
		});
		await published(site, site.blogId, { title: "Staff only", seo: { noindex: true } });

		expect(await llms(`${site.origin}/llms.txt`)).toBe(
			[
				"# Acme Bakery",
				"",
				"> Bread baked daily in Galway.",
				"",
				"## Pages",
				"",
				`- [About](${site.origin}/about.md)`,
				`- [Welcome](${site.origin}/index.html.md): Bread baked daily in Galway.`,
				"",
				"## Blog posts",
				"",
				`- [Rye \\[dark\\] \\*loaves\\*](${site.origin}/blog/rye-dark-loaves.md): Rye takes three days, and it is worth it.`,
				`- [Fresh bread](${site.origin}/blog/fresh-bread.md): Why we bake at dawn.`,
				"",
			].join("\n"),
		);
	});

	test("the SEO settings' name for the Site wins; a Site without a home page has no description line", async () => {
		const site = await newSite();
		await staff.api.seoSettings.update({ siteId: site.siteId, siteName: "Acme" });
		await published(site, site.blogId, { title: "Fresh bread" });

		expect(await llms(`${site.origin}/llms.txt`)).toBe(
			["# Acme", "", "## Blog posts", "", `- [Fresh bread](${site.origin}/blog/fresh-bread.md)`, ""].join("\n"),
		);
	});

	test("each language has its own, at its own address, listing what is shown in it", async () => {
		const site = await newSite(["fr", "de"]);
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.blogId,
			title: "Fresh bread",
			fields: { summary: "Why we bake at dawn." },
		});
		await editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: entry.id,
			language: "fr",
			title: "Pain frais",
			slug: "pain-frais",
			fields: { summary: "Pourquoi nous cuisons à l'aube." },
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await published(site, site.blogId, { title: "Rolls", hiddenLanguages: ["fr"] });
		await staff.api.languages.update({ siteId: site.siteId, code: "de", domain: `${site.slug}.de` });
		install.connectDomain(`${site.slug}.de`);
		await install.clock.advance(60_000);
		expect((await install.drainJobs()).failed).toEqual([]);

		expect(await llms(`${site.origin}/fr/llms.txt`)).toBe(
			[
				"# Acme Bakery",
				"",
				"## Blog posts",
				"",
				`- [Pain frais](${site.origin}/fr/blog/pain-frais.md): Pourquoi nous cuisons à l'aube.`,
				"",
			].join("\n"),
		);
		expect(await llms(`https://${site.slug}.de/llms.txt`)).toContain(
			`- [Fresh bread](https://${site.slug}.de/blog/fresh-bread.md): Why we bake at dawn.`,
		);
		// German lives on its own domain: no German llms.txt under the Primary domain's prefix.
		expect((await install.request(`${site.origin}/de/llms.txt`)).status).toBe(301);
		// The Default language has no prefix; nothing else is an llms.txt.
		expect((await install.request(`${site.origin}/en/llms.txt`)).status).toBe(404);
		expect((await install.request(`${site.origin}/blog/llms.txt`)).status).toBe(404);
	});

	test("a Post Type Staff leave out of the sitemaps is left out here too", async () => {
		const site = await newSite();
		await published(site, site.blogId, { title: "Fresh bread" });
		await staff.api.postTypes.update({ siteId: site.siteId, postTypeId: site.blogId, sitemap: false });

		expect(await llms(`${site.origin}/llms.txt`)).toBe("# Acme Bakery\n");
	});

	test("the Staging address has none, even for the people reviewing it", async () => {
		const site = await newSite();
		const reviewer = await openStaging(install, staff, site.siteId);

		expect((await reviewer.page("/llms.txt")).status).toBe(404);
	});
});
