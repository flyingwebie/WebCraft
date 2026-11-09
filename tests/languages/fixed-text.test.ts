// Fixed text in Templates (and the Components and Forms that reuse element trees) has a value per
// language: a text node keeps the text as written and, optionally, its text in other languages, which
// pages in those languages show. In Template markup it is written as a quoted string followed by its
// languages: {{ "Read more" fr: "Lire la suite" }}, in text and in attribute values.
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

async function newSite(): Promise<TestSite> {
	const slug = `fixed-text-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	for (const code of ["fr", "de"]) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	return { siteId, postTypeId: postType.id, origin: `https://${slug}.sites.test` };
}

async function body(site: TestSite, path: string): Promise<string> {
	const html = await (await install.request(`${site.origin}${path}`)).text();
	return /<main[^>]*>(.*)<\/main>/s.exec(html)?.[1] ?? "";
}

describe("fixed text per language", () => {
	test("pages show the text in their language, and as written in the languages it has none for", async () => {
		const site = await newSite();
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup:
				'<h1>{{ title }}</h1><p>{{ "Read more" fr: "Lire la suite" }} →</p><a href="/" aria-label="{{ "Home" fr: "Accueil" de: "Startseite" }}">⌂</a>',
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Fresh bread",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });

		expect(await body(site, "/blog/fresh-bread")).toBe(
			'<h1>Fresh bread</h1><p>Read more →</p><a href="/" aria-label="Home">⌂</a>',
		);
		expect(await body(site, "/fr/blog/fresh-bread")).toBe(
			'<h1>Fresh bread</h1><p>Lire la suite →</p><a href="/" aria-label="Accueil">⌂</a>',
		);
		expect(await body(site, "/de/blog/fresh-bread")).toBe(
			'<h1>Fresh bread</h1><p>Read more →</p><a href="/" aria-label="Startseite">⌂</a>',
		);
	});

	test("the Site template's fixed text too, on every page, the 404 page included", async () => {
		const site = await newSite();
		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: '<main>{{@outlet}}</main><footer><p>{{ "Open daily" fr: "Ouvert tous les jours" }}</p></footer>',
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });

		const html = await (await install.request(`${site.origin}/fr/missing`)).text();
		expect(html).toContain("<footer><p>Ouvert tous les jours</p></footer>");
	});

	test("is stored as a text node with its languages, and printed back as written", async () => {
		const site = await newSite();
		const markup = '<p>Hi {{ "there" fr: "là" pt-BR: "aí" }}! {{ "Say \\"hi\\" \\\\ back" de: "Sag \\"Hallo\\"" }}</p>';

		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup,
		});

		expect(saved.template.draft.nodes[0]).toMatchObject({
			children: [
				{ type: "text", text: "Hi " },
				{ type: "text", text: "there", translations: { fr: "là", "pt-BR": "aí" } },
				{ type: "text", text: "! " },
				{ type: "text", text: 'Say "hi" \\ back', translations: { de: 'Sag "Hallo"' } },
			],
		});
		const { id } = saved.template.draft.nodes[0] as { id: string };
		expect(saved.markup).toBe(markup.replace("<p>", `<p data-wc-id="${id}">`));
	});

	test("a tree gives each language's text by its code, kept in its canonical form", async () => {
		const site = await newSite();
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			tree: {
				version: 1,
				nodes: [
					{
						type: "element",
						tag: "p",
						attributes: [],
						classes: [],
						children: [{ type: "text", text: "Menu", translations: { "PT-br": "Cardápio", fr: "", it: "Menù" } }],
					},
				],
			},
		});

		expect(template.draft.nodes[0]).toMatchObject({
			children: [{ type: "text", text: "Menu", translations: { "pt-BR": "Cardápio", it: "Menù" } }],
		});
		await expect(
			staff.api.templates.saveEntryTemplate({
				siteId: site.siteId,
				postTypeId: site.postTypeId,
				tree: { version: 1, nodes: [{ type: "text", text: "Menu", translations: { french: "Carte" } }] },
			}),
		).rejects.toMatchObject({ code: "TEMPLATE_INVALID", data: { problems: [{ at: "nodes[0].translations" }] } });
	});

	test("markup that can't be read is refused where it is", async () => {
		const site = await newSite();
		for (const [markup, message] of [
			['<p>{{ "Hi" french: "Salut" }}</p>', "french isn't a language tag: write one such as fr or pt-BR."],
			['<p>{{ "Hi" fr: "Salut" fr: "Coucou" }}</p>', "fr is given twice."],
			['<p>{{ "Hi" fr "Salut" }}</p>', 'Write each language as fr: "…", after the text as written.'],
			[
				'<p>{{ "Hi \\q" }}</p>',
				'In quoted text, write \\" for a quote, \\\\ for a backslash and \\r for a carriage return.',
			],
		] as const) {
			await expect(
				staff.api.templates.saveEntryTemplateMarkup({ siteId: site.siteId, postTypeId: site.postTypeId, markup }),
			).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID", data: { problems: [{ message }] } });
		}
	});
});
