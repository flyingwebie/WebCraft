// Translations are stored per Field (ADR 0003): a Translatable field holds a value per language and
// falls back to the Default language one Field at a time; a shared Field holds one value for every
// language. Each language has its own address: the Default language unprefixed, the others under
// their prefix (ADR 0010). Slugs are translatable, and never change on their own once published.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = { siteId: string; postTypeId: string; pagesId: string; origin: string };

/** A Site in English and French, with a blog whose published Entry template shows its values. */
async function newSite(languages: string[] = ["fr"]): Promise<TestSite> {
	const slug = `translated-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "tagline", label: "Tagline", type: "text" },
			{ key: "price", label: "Price", type: "number" },
			{
				key: "team",
				label: "Team",
				type: "repeater",
				fields: [
					{ key: "name", label: "Name", type: "text", translatable: false },
					{ key: "role", label: "Role", type: "text" },
				],
			},
		],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			"<article><h1>{{ title }}</h1><p>{{ summary }}</p><p>{{ tagline }}</p><p>{{ price }}</p><p>{{ team.role }}</p></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	return {
		siteId,
		postTypeId: postType.id,
		pagesId: postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "",
		origin: `https://${slug}.sites.test`,
	};
}

async function freshBread(site: TestSite): Promise<string> {
	const { entry } = await editor.api.entries.create({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		title: "Fresh bread",
		fields: {
			summary: "Crusty",
			tagline: "Baked daily",
			price: 4,
			team: [{ id: "baker", name: "Aoife", role: "Baker" }],
		},
	});
	return entry.id;
}

async function visit(site: TestSite, path: string) {
	const response = await install.request(`${site.origin}${path}`);
	const html = await response.text();
	return {
		status: response.status,
		html,
		html_: /<html [^>]*>/.exec(html)?.[0] ?? "",
		article: /<article>(.*?)<\/article>/.exec(html)?.[1] ?? "",
	};
}

describe("values per language", () => {
	test("a Translatable field holds a value per language; the others fall back to the Default language one Field at a time", async () => {
		const site = await newSite();
		const entryId = await freshBread(site);

		const { entry } = await editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			language: "fr",
			title: "Pain frais",
			fields: { summary: "Croustillant", team: [{ id: "baker", role: "Boulangère" }] },
		});

		expect(entry.language).toBe("fr");
		expect(entry.draft).toEqual({
			title: "Pain frais",
			slug: "fresh-bread",
			parentId: null,
			hiddenLanguages: [],
			fields: {
				summary: "Croustillant",
				tagline: "Baked daily",
				price: 4,
				team: [{ id: "baker", name: "Aoife", role: "Boulangère" }],
			},
			seo: { title: null, description: null, canonical: null, image: null, noindex: false },
		});
		const english = (await editor.api.entries.get({ siteId: site.siteId, entryId })).entry;
		expect(english.draft).toMatchObject({
			title: "Fresh bread",
			fields: { summary: "Crusty", team: [{ id: "baker", name: "Aoife", role: "Baker" }] },
		});
	});

	test("a shared Field has one value in every language, whichever language writes it", async () => {
		const site = await newSite();
		const entryId = await freshBread(site);

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, language: "fr", fields: { price: 5 } });

		for (const language of ["en", "fr"]) {
			const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId, language });
			expect(entry.draft.fields.price).toBe(5);
		}
	});

	test("a language the Site doesn't have is refused", async () => {
		const site = await newSite();
		const entryId = await freshBread(site);

		await expect(editor.api.entries.get({ siteId: site.siteId, entryId, language: "de" })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
			data: { problems: [{ at: "language" }] },
		});
		await expect(
			editor.api.entries.saveDraft({ siteId: site.siteId, entryId, language: "de", title: "Frisches Brot" }),
		).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "language" }] } });
	});

	test("publishing checks the rules of every language's values", async () => {
		const site = await newSite();
		await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			fields: [{ key: "summary", label: "Summary", type: "text", maxLength: 10 }],
		});
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
			fields: { summary: "Croustillant et doré" },
		});

		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
			data: { problems: [{ at: "fields.summary", language: "fr", rule: "maxLength" }] },
		});
	});
});

describe("addresses per language", () => {
	test("the Default language is unprefixed and every other language is under its prefix, with its lang and dir", async () => {
		const site = await newSite(["fr", "ar"]);
		const entryId = await freshBread(site);
		await editor.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			language: "fr",
			title: "Pain frais",
			fields: { summary: "Croustillant" },
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId });

		const english = await visit(site, "/blog/fresh-bread");
		expect(english.status).toBe(200);
		expect(english.html_).toBe('<html lang="en" dir="ltr">');
		expect(english.article).toBe("<h1>Fresh bread</h1><p>Crusty</p><p>Baked daily</p><p>4</p><p>Baker</p>");

		const french = await visit(site, "/fr/blog/fresh-bread");
		expect(french.status).toBe(200);
		expect(french.html_).toBe('<html lang="fr" dir="ltr">');
		expect(french.html).toContain("<title>Pain frais · Acme Bakery</title>");
		expect(french.article).toBe("<h1>Pain frais</h1><p>Croustillant</p><p>Baked daily</p><p>4</p><p>Baker</p>");

		const arabic = await visit(site, "/ar/blog/fresh-bread");
		expect(arabic.html_).toBe('<html lang="ar" dir="rtl">');

		expect((await editor.api.entries.get({ siteId: site.siteId, entryId, language: "fr" })).entry.path).toBe(
			"/fr/blog/fresh-bread",
		);
		expect((await visit(site, "/de/blog/fresh-bread")).status).toBe(404);
	});

	test("a slug of its own gives the Entry its address in that language", async () => {
		const site = await newSite();
		const entryId = await freshBread(site);
		await editor.api.entries.publish({ siteId: site.siteId, entryId });

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, language: "fr", slug: "pain-frais" });
		expect((await visit(site, "/fr/blog/pain-frais")).status).toBe(404);
		await editor.api.entries.publish({ siteId: site.siteId, entryId });

		expect((await visit(site, "/fr/blog/pain-frais")).status).toBe(200);
		expect((await visit(site, "/fr/blog/fresh-bread")).status).toBe(404);
		expect((await visit(site, "/blog/fresh-bread")).status).toBe(200);
		const [published] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(published?.details).toMatchObject({
			pathChanges: [{ entryId, language: "fr", from: "/fr/blog/fresh-bread", to: "/fr/blog/pain-frais" }],
		});
	});

	test("a published slug never changes on its own: a language without its own slug keeps the one it was published with", async () => {
		const site = await newSite();
		const entryId = await freshBread(site);
		await editor.api.entries.publish({ siteId: site.siteId, entryId });

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, slug: "fresh-loaf", title: "Fresh loaf" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId });

		expect((await visit(site, "/blog/fresh-loaf")).status).toBe(200);
		expect((await visit(site, "/fr/blog/fresh-bread")).status).toBe(200);
		expect((await visit(site, "/fr/blog/fresh-loaf")).status).toBe(404);
		const french = await editor.api.entries.get({ siteId: site.siteId, entryId, language: "fr" });
		expect(french.entry.path).toBe("/fr/blog/fresh-bread");
		expect(french.entry.published?.slug).toBe("fresh-bread");
	});

	test("two Entries can't share a slug in any language", async () => {
		const site = await newSite();
		const first = await freshBread(site);
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: first, language: "fr", slug: "pain" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: first });
		const { entry: second } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Pain",
		});

		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: second.id })).rejects.toMatchObject({
			code: "ENTRY_SLUG_TAKEN",
			data: { slug: "pain", language: "fr" },
		});
	});

	test("Pages: the home page answers at each language's prefix, and Pages nest under it", async () => {
		const site = await newSite();
		const { entry: home } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Welcome",
		});
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: home.id, language: "fr", title: "Bienvenue" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: home.id });
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: home.id });
		const { entry: about } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "About",
		});
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: about.id, language: "fr", slug: "a-propos" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: about.id });
		const { entry: team } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Team",
			parentId: about.id,
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: team.id });

		expect((await visit(site, "/fr")).html).toContain("<title>Bienvenue · Acme Bakery</title>");
		expect((await visit(site, "/fr/")).html).toContain("<title>Bienvenue · Acme Bakery</title>");
		const own = await install.request(`${site.origin}/fr/welcome`);
		expect(own.status).toBe(301);
		expect(own.headers.get("location")).toBe("/fr");
		expect((await visit(site, "/fr/a-propos/team")).status).toBe(200);
		expect((await visit(site, "/about/team")).status).toBe(200);
		expect((await editor.api.entries.get({ siteId: site.siteId, entryId: team.id, language: "fr" })).entry.path).toBe(
			"/fr/a-propos/team",
		);
		expect((await editor.api.entries.get({ siteId: site.siteId, entryId: home.id, language: "fr" })).entry.path).toBe(
			"/fr",
		);
	});

	test("the Default language's own prefix sends visitors to the unprefixed address", async () => {
		const site = await newSite();
		const entryId = await freshBread(site);
		await editor.api.entries.publish({ siteId: site.siteId, entryId });

		const response = await install.request(`${site.origin}/en/blog/fresh-bread`);

		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe("/blog/fresh-bread");
	});
});

describe("adding a language", () => {
	test("published Entries and Pages answer in it at once, at their Default language slugs, until they get their own", async () => {
		const site = await newSite([]);
		const entryId = await freshBread(site);
		await editor.api.entries.publish({ siteId: site.siteId, entryId });
		const { entry: about } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "About",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: about.id });
		expect((await visit(site, "/fr/blog/fresh-bread")).status).toBe(404);

		await staff.api.languages.add({ siteId: site.siteId, code: "fr" });

		const french = await visit(site, "/fr/blog/fresh-bread");
		expect(french.status).toBe(200);
		expect(french.html_).toBe('<html lang="fr" dir="ltr">');
		expect((await visit(site, "/fr/about")).status).toBe(200);
		expect((await editor.api.entries.get({ siteId: site.siteId, entryId, language: "fr" })).entry.path).toBe(
			"/fr/blog/fresh-bread",
		);
	});

	test("its prefix can't be a path the Site already answers", async () => {
		const site = await newSite([]);
		const { entry: page } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Fr",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: page.id });
		await expect(staff.api.languages.add({ siteId: site.siteId, code: "fr" })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/fr", by: { kind: "page", id: page.id } },
		});

		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Recettes",
			urlPattern: "/de/{slug}",
		});
		await expect(staff.api.languages.add({ siteId: site.siteId, code: "de" })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/de", by: { kind: "postType", id: postType.id } },
		});

		const { postType: topLevel } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Specials",
			urlPattern: "/{slug}/today",
		});
		const { entry: special } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: topLevel.id,
			title: "It",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: special.id });
		await expect(staff.api.languages.add({ siteId: site.siteId, code: "it" })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/it/today", by: { kind: "postType", id: topLevel.id } },
		});
	});

	test("its prefix stays the language's: no Page, Entry or URL pattern can take it", async () => {
		const site = await newSite(["fr"]);
		const { entry: page } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Fr",
		});
		const language = { kind: "language", code: "fr", name: "Français" };

		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: page.id })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/fr", by: language },
		});
		await expect(
			staff.api.postTypes.create({ siteId: site.siteId, name: "Recettes", urlPattern: "/fr/{slug}" }),
		).rejects.toMatchObject({ code: "PATH_TAKEN", data: { path: "/fr", by: language } });
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Specials",
			urlPattern: "/{slug}/today",
		});
		const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: postType.id, title: "Fr" });
		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/fr/today", by: language },
		});
		// Under the prefix, and in other languages, the same slug is fine.
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: page.id, slug: "francais" });
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: page.id, language: "fr", slug: "fr" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: page.id });
		expect((await visit(site, "/fr/fr")).status).toBe(200);
	});
});
