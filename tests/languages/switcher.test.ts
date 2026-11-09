// The Language switcher: `{{@languageSwitcher}}` in a Template links to the same page in each of the
// Site's languages (that language's home page where the Entry is hidden), the current one marked.
// Following a link remembers the visitor's choice in a cookie, without JavaScript.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

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

type TestSite = { siteId: string; postTypeId: string; origin: string };

/** A Site whose published Site template shows the Language switcher in its header. */
async function newSite(languages: string[]): Promise<TestSite> {
	const slug = `switcher-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const entryTemplate = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: entryTemplate.template.id });
	const siteTemplate = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header>{{@languageSwitcher}}</header><main>{{@outlet}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: siteTemplate.template.id });
	return { siteId, postTypeId: postType.id, origin: `https://${slug}.sites.test` };
}

async function publishedEntry(site: TestSite, title: string, change: { frenchSlug?: string; hidden?: string[] } = {}) {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title });
	if (change.frenchSlug) {
		await editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: entry.id,
			language: "fr",
			slug: change.frenchSlug,
		});
	}
	if (change.hidden) {
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: entry.id, hiddenLanguages: change.hidden });
	}
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

async function headerAt(site: TestSite, path: string): Promise<string> {
	const html = await (await install.request(`${site.origin}${path}`)).text();
	return /<header>(.*?)<\/header>/.exec(html)?.[1] ?? "";
}

describe("the Language switcher", () => {
	test("links to the same Entry in each language, in the page's words, the current language marked", async () => {
		const site = await newSite(["fr", "ar"]);
		await publishedEntry(site, "Fresh bread", { frenchSlug: "pain-frais" });

		expect(await headerAt(site, "/fr/blog/pain-frais")).toBe(
			[
				'<nav class="wc-language-switcher" aria-label="Langue"><ul>',
				'<li><a href="/_wc/lang/blog/fresh-bread" hreflang="en" lang="en">English</a></li>',
				'<li><a href="/_wc/lang/fr/blog/pain-frais" hreflang="fr" lang="fr" aria-current="true">Français</a></li>',
				'<li><a href="/_wc/lang/ar/blog/fresh-bread" hreflang="ar" lang="ar" dir="rtl">العربية</a></li>',
				"</ul></nav>",
			].join(""),
		);
		expect(await headerAt(site, "/blog/fresh-bread")).toContain('aria-label="Language"');
	});

	test("where the Entry is hidden, it links to that language's home page; on the 404 page, to every home page", async () => {
		const site = await newSite(["fr"]);
		await publishedEntry(site, "Fresh bread", { hidden: ["fr"] });

		expect(await headerAt(site, "/blog/fresh-bread")).toContain(
			'<li><a href="/_wc/lang/fr" hreflang="fr" lang="fr">Français</a></li>',
		);
		const notFound = await headerAt(site, "/fr/missing");
		expect(notFound).toContain('<a href="/_wc/lang/" hreflang="en" lang="en">English</a>');
		expect(notFound).toContain('<a href="/_wc/lang/fr" hreflang="fr" lang="fr" aria-current="true">Français</a>');
	});

	test("shows nothing on a Site with one language", async () => {
		const site = await newSite([]);
		await publishedEntry(site, "Fresh bread");

		expect(await headerAt(site, "/blog/fresh-bread")).toBe("");
	});

	test("following a link remembers the choice in a cookie, then goes to the page", async () => {
		const site = await newSite(["fr"]);
		await publishedEntry(site, "Fresh bread", { frenchSlug: "pain-frais" });

		const french = await install.request(`${site.origin}/_wc/lang/fr/blog/pain-frais`);
		expect(french.status).toBe(303);
		expect(french.headers.get("location")).toBe("/fr/blog/pain-frais");
		expect(french.headers.get("cache-control")).toBe("no-store");
		expect(french.headers.get("set-cookie")).toBe(
			"__Host-webcraft.language=fr; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax",
		);

		const english = await install.request(`${site.origin}/_wc/lang/`);
		expect(english.headers.get("location")).toBe("/");
		expect(english.headers.get("set-cookie")).toStartWith("__Host-webcraft.language=en;");
	});

	test("only ever goes to a path on the Site", async () => {
		const site = await newSite(["fr"]);
		for (const path of ["/_wc/lang//evil.example/x", "/_wc/lang/fr/%2F%2Fevil.example", "/_wc/lang/_media/x"]) {
			const response = await install.request(`${site.origin}${path}`);
			expect(response.status).toBe(404);
			expect(response.headers.get("set-cookie")).toBeNull();
		}
	});
});

describe("in Template markup", () => {
	test("is written {{@languageSwitcher}}, alone, and can't go where a <nav> can't", async () => {
		const site = await newSite(["fr"]);
		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<header><div>{{@languageSwitcher}}</div></header><main>{{@outlet}}</main>",
		});
		expect(saved.template.draft.nodes[0]).toMatchObject({
			children: [{ tag: "div", children: [{ type: "languageSwitcher" }] }],
		});
		expect(saved.markup).toContain("<div data-wc-id");
		expect(saved.markup).toContain(">{{@languageSwitcher}}</div>");

		for (const [markup, message] of [
			["<p>{{@languageSwitcher}}</p>", "{{@languageSwitcher}} is a list of links in a <nav>: it can't go inside <p>."],
			[
				'<a href="/">{{@languageSwitcher}}</a>',
				"{{@languageSwitcher}} is a list of links in a <nav>: it can't go inside <a>.",
			],
			["<ul>{{@languageSwitcher}}</ul>", "{{@languageSwitcher}} goes inside an <li>, not directly in a list."],
			["{{@languageSwitcher fr}}", "{{@languageSwitcher}} takes nothing: write it alone."],
		] as const) {
			await expect(
				staff.api.templates.saveEntryTemplateMarkup({ siteId: site.siteId, postTypeId: site.postTypeId, markup }),
			).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID", data: { problems: [{ message }] } });
		}
	});
});
