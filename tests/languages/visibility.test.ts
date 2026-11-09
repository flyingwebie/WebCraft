// Language visibility: an Entry can be hidden in any of the Site's languages (Content, in its Draft,
// live once published). Hidden, it has no page in that language (404), no `hreflang` alternate, and no
// place where Entries are listed in that language (Relationships today; Loops and sitemaps call the
// same rule).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = { siteId: string; postTypeId: string; categoriesId: string; origin: string };

/** A Site in English, French and German with blog posts that point at categories. */
async function newSite(): Promise<TestSite> {
	const slug = `visibility-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	for (const code of ["fr", "de"]) await staff.api.languages.add({ siteId, code });
	const categories = await staff.api.postTypes.create({
		siteId,
		key: "categories",
		name: "Categories",
		urlPattern: "/category/{slug}",
	});
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text", maxLength: 20 },
			{ key: "categories", label: "Categories", type: "relationship", postTypes: ["categories"], multiple: true },
		],
	});
	for (const [postTypeId, markup] of [
		[postType.id, "<h1>{{ title }}</h1><p>{{ categories }}</p>"],
		[categories.postType.id, "<h1>{{ title }}</h1>"],
	] as const) {
		const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup });
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	}
	return {
		siteId,
		postTypeId: postType.id,
		categoriesId: categories.postType.id,
		origin: `https://${slug}.sites.test`,
	};
}

async function publishedEntry(site: TestSite, postTypeId: string, title: string, fields = {}): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId, title, fields });
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

async function visit(site: TestSite, path: string) {
	const response = await install.request(`${site.origin}${path}`);
	const html = await response.text();
	return {
		status: response.status,
		html,
		alternates: [...html.matchAll(/hreflang="([^"]*)"/g)].map((match) => match[1]),
	};
}

describe("language visibility", () => {
	test("hidden in a language, a published Entry has no page there and no alternate; the rest stay", async () => {
		const site = await newSite();
		const entryId = await publishedEntry(site, site.postTypeId, "Fresh bread");

		const { entry } = await author.api.entries.saveDraft({ siteId: site.siteId, entryId, hiddenLanguages: ["fr"] });
		expect(entry.draft.hiddenLanguages).toEqual(["fr"]);
		expect(entry.published?.hiddenLanguages).toEqual([]);
		// The Draft changes nothing visitors see until it is published.
		expect((await visit(site, "/fr/blog/fresh-bread")).status).toBe(200);

		await editor.api.entries.publish({ siteId: site.siteId, entryId });

		const french = await visit(site, "/fr/blog/fresh-bread");
		expect(french.status).toBe(404);
		expect(french.html).toContain('<html lang="fr" dir="ltr">');
		expect((await visit(site, "/de/blog/fresh-bread")).alternates).toEqual(["en", "de", "x-default"]);
		expect((await visit(site, "/blog/fresh-bread")).status).toBe(200);

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, hiddenLanguages: [] });
		await editor.api.entries.publish({ siteId: site.siteId, entryId });
		expect((await visit(site, "/fr/blog/fresh-bread")).status).toBe(200);
	});

	test("hidden in the Default language, it is still in the others, without x-default", async () => {
		const site = await newSite();
		const entryId = await publishedEntry(site, site.postTypeId, "Fresh bread");

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, hiddenLanguages: ["en"] });
		await editor.api.entries.publish({ siteId: site.siteId, entryId });

		expect((await visit(site, "/blog/fresh-bread")).status).toBe(404);
		expect((await visit(site, "/fr/blog/fresh-bread")).alternates).toEqual(["fr", "de"]);
	});

	test("only the Site's languages can be hidden", async () => {
		const site = await newSite();
		const entryId = await publishedEntry(site, site.postTypeId, "Fresh bread");

		await expect(
			editor.api.entries.saveDraft({ siteId: site.siteId, entryId, hiddenLanguages: ["it"] }),
		).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "hiddenLanguages" }] } });
	});

	test("a language it is hidden in isn't checked when it is published", async () => {
		const site = await newSite();
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Fresh bread",
			fields: { summary: "Crusty" },
		});
		await editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: entry.id,
			language: "fr",
			fields: { summary: "Croustillant et doré, sorti du four" },
		});
		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
		});

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: entry.id, hiddenLanguages: ["fr"] });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	});

	test("Entries hidden in the page's language are left out where Entries are listed", async () => {
		const site = await newSite();
		const rye = await publishedEntry(site, site.categoriesId, "Rye");
		const spelt = await publishedEntry(site, site.categoriesId, "Spelt");
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: spelt, hiddenLanguages: ["fr"] });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: spelt });
		await publishedEntry(site, site.postTypeId, "Fresh bread", { categories: [rye, spelt] });

		expect((await visit(site, "/blog/fresh-bread")).html).toContain("<p>Rye, Spelt</p>");
		expect((await visit(site, "/fr/blog/fresh-bread")).html).toContain("<p>Rye</p>");
	});
});
