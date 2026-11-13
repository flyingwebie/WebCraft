// The Globals and the Media library's texts (title, alt text, caption) hold a value per language like
// Entries' Fields, falling back to the Default language one value at a time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

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

async function newSite(siteTemplate: string): Promise<TestSite> {
	const slug = `globals-media-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	for (const code of ["fr", "de"]) await staff.api.languages.add({ siteId, code });
	await staff.api.globals.setFields({
		siteId,
		fields: [
			{ key: "footer", label: "Footer", type: "text", maxLength: 25 },
			{ key: "phone", label: "Phone", type: "text", translatable: false },
		],
	});
	const saved = await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup: siteTemplate });
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const entryTemplate = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: entryTemplate.template.id });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, postTypeId: postType.id, origin: `https://${slug}.live.test` };
}

async function footerAt(site: TestSite, path: string): Promise<string> {
	const html = await (await install.request(`${site.origin}${path}`)).text();
	return /<footer>(.*?)<\/footer>/s.exec(html)?.[1] ?? "";
}

describe("the Globals per language", () => {
	test("hold a value per language for Translatable fields, one for shared ones, and pages show theirs", async () => {
		const site = await newSite(
			"<main>{{@outlet}}</main><footer><p>{{ site.footer }}</p><p>{{ site.phone }}</p></footer>",
		);
		await editor.api.globals.saveDraft({ siteId: site.siteId, fields: { footer: "Open daily", phone: "01 234" } });
		const { globals } = await editor.api.globals.saveDraft({
			siteId: site.siteId,
			language: "fr",
			fields: { footer: "Ouvert tous les jours" },
		});
		expect(globals).toMatchObject({ language: "fr", draft: { footer: "Ouvert tous les jours", phone: "01 234" } });
		await editor.api.globals.publish({ siteId: site.siteId });

		expect(await footerAt(site, "/blog/fresh-bread")).toBe("<p>Open daily</p><p>01 234</p>");
		expect(await footerAt(site, "/fr/blog/fresh-bread")).toBe("<p>Ouvert tous les jours</p><p>01 234</p>");
		expect(await footerAt(site, "/de/blog/fresh-bread")).toBe("<p>Open daily</p><p>01 234</p>");
		expect((await editor.api.globals.get({ siteId: site.siteId, language: "de" })).globals.draft.footer).toBe(
			"Open daily",
		);
	});

	test("publishing checks every language's values, and only the Site's languages can be written", async () => {
		const site = await newSite("<main>{{@outlet}}</main>");
		await editor.api.globals.saveDraft({
			siteId: site.siteId,
			language: "fr",
			fields: { footer: "Ouvert tous les jours, même le dimanche" },
		});

		await expect(editor.api.globals.publish({ siteId: site.siteId })).rejects.toMatchObject({
			code: "GLOBALS_INVALID",
			data: { problems: [{ at: "fields.footer", language: "fr", rule: "maxLength" }] },
		});
		await expect(
			editor.api.globals.saveDraft({ siteId: site.siteId, language: "it", fields: { footer: "Aperto" } }),
		).rejects.toMatchObject({ code: "GLOBALS_INVALID", data: { problems: [{ at: "language" }] } });
	});
});

describe("Media texts per language", () => {
	test("alt text is written per language; pages show their language's, falling back to the Default language's", async () => {
		const site = await newSite("<main>{{@outlet}}</main>");
		const { media } = await editor.api.media.upload({
			siteId: site.siteId,
			file: upload(await photo({ width: 400, height: 300 }), "loaf.jpg"),
		});
		await editor.api.media.update({ siteId: site.siteId, mediaId: media.id, alt: "A round loaf" });
		const french = await editor.api.media.update({
			siteId: site.siteId,
			mediaId: media.id,
			language: "fr",
			alt: "Une miche ronde",
		});
		expect(french.media).toMatchObject({ alt: "Une miche ronde" });
		expect((await install.drainJobs()).failed).toEqual([]);
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: `<h1>{{ title }}</h1><img src="media:${media.id}">`,
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });

		const alt = async (path: string) =>
			/<img [^>]*alt="([^"]*)"/.exec(await (await install.request(`${site.origin}${path}`)).text())?.[1];
		expect(await alt("/blog/fresh-bread")).toBe("A round loaf");
		expect(await alt("/fr/blog/fresh-bread")).toBe("Une miche ronde");
		expect(await alt("/de/blog/fresh-bread")).toBe("A round loaf");
		expect((await editor.api.media.get({ siteId: site.siteId, mediaId: media.id, language: "de" })).media.alt).toBe(
			"A round loaf",
		);
		await expect(
			editor.api.media.update({ siteId: site.siteId, mediaId: media.id, language: "it", alt: "Una pagnotta" }),
		).rejects.toMatchObject({ code: "MEDIA_INVALID", data: { problems: [{ at: "language" }] } });
	});
});
