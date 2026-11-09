// Every page of a Site with more than one language links its languages with `hreflang`
// (ADR 0010): one alternate per language it exists in, at that language's address, and `x-default`
// at the Default language's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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

type TestSite = { siteId: string; postTypeId: string; pagesId: string; origin: string };

async function newSite(languages: string[]): Promise<TestSite> {
	const slug = `alternates-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	return {
		siteId,
		postTypeId: postType.id,
		pagesId: postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "",
		origin: `https://${slug}.live.test`,
	};
}

/** The `hreflang` alternates in a page's `<head>`, as `[hreflang, href]`. */
async function alternatesAt(site: TestSite, path: string): Promise<string[][]> {
	const response = await install.request(`${site.origin}${path}`);
	const html = await response.text();
	return [...html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g)].map((match) => [
		match[1] ?? "",
		match[2] ?? "",
	]);
}

describe("hreflang", () => {
	test("each page lists every language it is in, at its address there, and x-default at the Default language's", async () => {
		const site = await newSite(["fr", "pt-BR"]);
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Fresh bread",
		});
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: entry.id, language: "fr", slug: "pain-frais" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });

		const expected = [
			["en", `${site.origin}/blog/fresh-bread`],
			["fr", `${site.origin}/fr/blog/pain-frais`],
			["pt-BR", `${site.origin}/pt-br/blog/fresh-bread`],
			["x-default", `${site.origin}/blog/fresh-bread`],
		];
		expect(await alternatesAt(site, "/blog/fresh-bread")).toEqual(expected);
		expect(await alternatesAt(site, "/fr/blog/pain-frais")).toEqual(expected);
		expect(await alternatesAt(site, "/pt-br/blog/fresh-bread")).toEqual(expected);
	});

	test("the home page's alternates are each language's root", async () => {
		const site = await newSite(["fr"]);
		const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title: "Home" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: entry.id });

		expect(await alternatesAt(site, "/fr")).toEqual([
			["en", `${site.origin}/`],
			["fr", `${site.origin}/fr`],
			["x-default", `${site.origin}/`],
		]);
	});

	test("a Site with one language and the 404 page have none", async () => {
		const single = await newSite([]);
		const { entry } = await editor.api.entries.create({
			siteId: single.siteId,
			postTypeId: single.postTypeId,
			title: "Fresh bread",
		});
		await editor.api.entries.publish({ siteId: single.siteId, entryId: entry.id });
		expect(await alternatesAt(single, "/blog/fresh-bread")).toEqual([]);

		const site = await newSite(["fr"]);
		expect(await alternatesAt(site, "/fr/missing")).toEqual([]);
	});
});
