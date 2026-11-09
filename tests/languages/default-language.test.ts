// Changing a Site's Default language (Structure): allowed after a warning, in two steps. The new
// Default language loses its prefix and the old one gets one; shared values keep their value; every
// published address that changes is listed (Redirect rules follow them), and the new Default
// language's old addresses go on to the new ones, so no published URL breaks silently.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let owner: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = { siteId: string; postTypeId: string; pagesId: string; origin: string; bread: string; rolls: string };

/**
 * A Site in English and French, with two published blog posts: Fresh bread, translated into French
 * (`pain-frais`), and Rolls, not translated.
 */
async function newSite(): Promise<TestSite> {
	const slug = `default-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	await staff.api.languages.add({ siteId, code: "fr" });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "price", label: "Price", type: "number" },
			{
				key: "details",
				label: "Details",
				type: "group",
				fields: [{ key: "weight", label: "Weight", type: "number" }],
			},
		],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1><p>{{ price }}</p><p>{{ details.weight }}</p>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry: bread } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { price: 4, details: { weight: 800 } },
	});
	await editor.api.entries.saveDraft({
		siteId,
		entryId: bread.id,
		language: "fr",
		title: "Pain frais",
		slug: "pain-frais",
	});
	await editor.api.entries.publish({ siteId, entryId: bread.id });
	const { entry: rolls } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Rolls" });
	await editor.api.entries.publish({ siteId, entryId: rolls.id });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	return {
		siteId,
		postTypeId: postType.id,
		pagesId: postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "",
		origin: `https://${slug}.live.test`,
		bread: bread.id,
		rolls: rolls.id,
	};
}

async function visit(site: TestSite, path: string) {
	const response = await install.request(`${site.origin}${path}`);
	const html = await response.text();
	return {
		status: response.status,
		location: response.headers.get("location"),
		lang: /<html lang="([^"]*)"/.exec(html)?.[1],
		h1: /<h1>(.*?)<\/h1>/.exec(html)?.[1],
		paragraphs: [...html.matchAll(/<p>(.*?)<\/p>/g)].map((match) => match[1]),
	};
}

describe("changing the Default language", () => {
	test("the first step changes nothing: it says what will change and asks to confirm", async () => {
		const site = await newSite();

		const asked = await staff.api.languages.setDefault({ siteId: site.siteId, code: "fr" });

		expect(asked).toEqual({
			changed: false,
			preview: { from: "en", to: "fr", changedPaths: 4, withoutOwnTitle: 1 },
			confirmation: { id: expect.any(String), expiresAt: expect.any(Date) },
		});
		expect((await staff.api.languages.list({ siteId: site.siteId })).settings.defaultLanguage).toBe("en");
		expect((await visit(site, "/blog/fresh-bread")).status).toBe(200);
		await expect(owner.api.languages.setDefault({ siteId: site.siteId, code: "fr" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("confirmed, the new Default language is unprefixed and the old one gets its prefix", async () => {
		const site = await newSite();
		const asked = await staff.api.languages.setDefault({ siteId: site.siteId, code: "fr" });
		if (asked.changed) throw new Error("It should ask first.");

		const done = await staff.api.languages.setDefault({
			siteId: site.siteId,
			code: "fr",
			confirmation: asked.confirmation.id,
		});

		if (!done.changed) throw new Error("It should have changed.");
		expect(done.settings.defaultLanguage).toBe("fr");
		expect(done.settings.languages.map((language) => [language.code, language.prefix, language.default])).toEqual([
			["fr", null, true],
			["en", "en", false],
		]);
		expect(done.pathChanges).toEqual(
			expect.arrayContaining([
				{ entryId: site.bread, language: "en", from: "/blog/fresh-bread", to: "/en/blog/fresh-bread" },
				{ entryId: site.bread, language: "fr", from: "/fr/blog/pain-frais", to: "/blog/pain-frais" },
				{ entryId: site.rolls, language: "en", from: "/blog/rolls", to: "/en/blog/rolls" },
				{ entryId: site.rolls, language: "fr", from: "/fr/blog/rolls", to: "/blog/rolls" },
			]),
		);
		expect(done.pathChanges).toHaveLength(4);

		expect(await visit(site, "/blog/pain-frais")).toMatchObject({ status: 200, lang: "fr", h1: "Pain frais" });
		expect(await visit(site, "/en/blog/fresh-bread")).toMatchObject({ status: 200, lang: "en", h1: "Fresh bread" });
		// The new Default language's old addresses go on to the new ones.
		expect(await visit(site, "/fr/blog/pain-frais")).toMatchObject({ status: 301, location: "/blog/pain-frais" });
		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "defaultLanguage.change",
			details: { from: "en", to: "fr", changedPaths: 4 },
		});
	});

	test("shared values keep their value in every language, and fallbacks now point at the new Default language", async () => {
		const site = await newSite();
		const asked = await staff.api.languages.setDefault({ siteId: site.siteId, code: "fr" });
		if (asked.changed) throw new Error("It should ask first.");
		await staff.api.languages.setDefault({ siteId: site.siteId, code: "fr", confirmation: asked.confirmation.id });

		for (const language of ["en", "fr"]) {
			const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.bread, language });
			expect(entry.draft.fields).toEqual({ price: 4, details: { weight: 800 } });
			expect(entry.status).toBe("published");
		}
		expect((await visit(site, "/en/blog/fresh-bread")).paragraphs).toEqual(["4", "800"]);
		// Rolls has no French title: French is the Default language now, so there is nothing to fall back to.
		const { entry: rolls } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.rolls });
		expect(rolls.language).toBe("fr");
		expect(rolls.draft.title).toBe("");
		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: site.rolls })).rejects.toMatchObject({
			code: "ENTRY_INCOMPLETE",
			data: { missing: ["title", "slug"] },
		});
		// An Entry with its own values in the new Default language publishes as before.
		await editor.api.entries.publish({ siteId: site.siteId, entryId: site.bread });
	});

	test("Pages keep their places and hidden languages", async () => {
		const site = await newSite();
		const { entry: about } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "About",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: about.id });
		const { entry: team } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Team",
			parentId: about.id,
			hiddenLanguages: ["en"],
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: team.id });

		const asked = await staff.api.languages.setDefault({ siteId: site.siteId, code: "fr" });
		if (asked.changed) throw new Error("It should ask first.");
		await staff.api.languages.setDefault({ siteId: site.siteId, code: "fr", confirmation: asked.confirmation.id });

		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: team.id, language: "en" });
		expect(entry.draft).toMatchObject({ parentId: about.id, hiddenLanguages: ["en"] });
		expect((await visit(site, "/about/team")).status).toBe(200);
		expect((await visit(site, "/en/about/team")).status).toBe(404);
		expect((await visit(site, "/en/about")).status).toBe(200);
	});

	test("refused when a page of the new Default language is where the old one's prefix would be", async () => {
		const site = await newSite();
		const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title: "En" });
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: entry.id, slug: "english" });
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: entry.id, language: "fr", slug: "en" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });

		await expect(staff.api.languages.setDefault({ siteId: site.siteId, code: "fr" })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/en", by: { kind: "page", id: entry.id } },
		});
	});

	test("refuses a language the Site doesn't have, and the one that is already its Default language", async () => {
		const site = await newSite();

		await expect(staff.api.languages.setDefault({ siteId: site.siteId, code: "de" })).rejects.toMatchObject({
			code: "LANGUAGE_NOT_FOUND",
		});
		await expect(staff.api.languages.setDefault({ siteId: site.siteId, code: "en" })).rejects.toMatchObject({
			code: "LANGUAGE_INVALID",
			data: { problems: [{ at: "code" }] },
		});
	});
});

describe("a Page at the Default language's own prefix", () => {
	test("still answers there: the prefix only sends on what nothing else answers", async () => {
		const site = await newSite();
		const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title: "En" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });

		expect((await visit(site, "/en")).status).toBe(200);
		expect(await visit(site, "/en/blog/rolls")).toMatchObject({ status: 301, location: "/blog/rolls" });
	});
});
