// The 404 page per language: Staff may choose a Page as one language's 404 page; the Site's own 404
// page answers in the languages without one, and the built-in one speaks the page's language.
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

type TestSite = { siteId: string; pagesId: string; origin: string };

async function newSite(languages: string[]): Promise<TestSite> {
	const slug = `not-found-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	return {
		siteId,
		pagesId: postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "",
		origin: `https://${slug}.sites.test`,
	};
}

async function publishedPage(site: TestSite, title: string): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title });
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

async function visit(site: TestSite, path: string) {
	const response = await install.request(`${site.origin}${path}`);
	const html = await response.text();
	return {
		status: response.status,
		lang: /<html lang="([^"]*)"/.exec(html)?.[1],
		title: /<title>(.*?)<\/title>/.exec(html)?.[1],
		main: /<main[^>]*>(.*?)<\/main>/.exec(html)?.[1],
	};
}

describe("the 404 page per language", () => {
	test("a Page chosen for one language answers there; the Site's own 404 page answers in the others", async () => {
		const site = await newSite(["fr", "de"]);
		const lost = await publishedPage(site, "Lost your way?");
		const perdu = await publishedPage(site, "Perdu ?");
		await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: lost });

		const { settings } = await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: perdu, language: "fr" });

		expect(settings).toEqual({
			homePage: null,
			notFoundPage: { id: lost, title: "Lost your way?" },
			searchPage: null,
			languageNotFoundPages: { fr: { id: perdu, title: "Perdu ?" } },
		});
		expect(await visit(site, "/fr/missing")).toMatchObject({ status: 404, lang: "fr", title: "Perdu ? · Acme Bakery" });
		expect(await visit(site, "/de/missing")).toMatchObject({
			status: 404,
			lang: "de",
			title: "Lost your way? · Acme Bakery",
		});
		expect(await visit(site, "/missing")).toMatchObject({ status: 404, title: "Lost your way? · Acme Bakery" });
		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "notFoundPage.change",
			details: { pageId: perdu, title: "Perdu ?", language: "fr" },
		});

		await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: null, language: "fr" });
		expect(await visit(site, "/fr/missing")).toMatchObject({ title: "Lost your way? · Acme Bakery" });
	});

	test("the built-in 404 page speaks the page's language, falling back to English", async () => {
		const site = await newSite(["fr", "de", "ja"]);

		expect(await visit(site, "/fr/missing")).toMatchObject({
			status: 404,
			lang: "fr",
			title: "Page introuvable · Acme Bakery",
			main: "<h1>Page introuvable</h1><p>Il n’y a aucune page à cette adresse.</p>",
		});
		expect((await visit(site, "/de/missing")).title).toBe("Seite nicht gefunden · Acme Bakery");
		expect(await visit(site, "/ja/missing")).toMatchObject({ lang: "ja", title: "Page not found · Acme Bakery" });
	});

	test("a language the Site doesn't have is refused", async () => {
		const site = await newSite([]);
		const lost = await publishedPage(site, "Lost your way?");

		await expect(
			staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: lost, language: "fr" }),
		).rejects.toMatchObject({ code: "LANGUAGE_NOT_FOUND" });
	});
});
