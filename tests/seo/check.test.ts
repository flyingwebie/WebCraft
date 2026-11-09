// The SEO check (a Check, GLOSSARY.md): while an Entry is edited, it warns about what search engines
// and other sites will get from its Draft (a title or description too long or too short, no
// description, no social image, a social image without alt text), worked out through the same
// fallbacks pages use. Checks are warnings: they never keep an Entry from being published.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let postTypeId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	await staff.api.languages.add({ siteId, code: "fr" });
	postTypeId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Blog posts",
			urlPattern: "/blog/{slug}",
			fields: [
				{ key: "body", label: "Body", type: "body" },
				{ key: "cover", label: "Cover", type: "media" },
			],
		})
	).postType.id;
});

afterAll(async () => {
	await install.close();
});

type Check = { at: string; check: string; params?: Record<string, unknown>; message?: unknown };

/** The SEO check's warnings on an Entry, in a language. */
async function seoChecks(entryId: string, language?: string): Promise<Check[]> {
	const { entry } = await editor.api.entries.get({ siteId, entryId, language });
	return (entry.checks as Check[]).filter((check) => check.at.startsWith("seo."));
}

const sentence = "Our sourdough is shaped by hand and baked slowly in a stone oven every single morning.";

async function image(name: string, alt?: string): Promise<string> {
	const bytes = await photo({ width: 1300, height: 700, format: "jpeg" });
	const { media } = await editor.api.media.upload({ siteId, file: upload(bytes, name) });
	await install.drainJobs();
	if (alt) await editor.api.media.update({ siteId, mediaId: media.id, alt });
	return media.id;
}

describe("the SEO check", () => {
	test("warns about a long title, a missing description and a missing social image, never blocking a publish", async () => {
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Everything you ever wanted to know about our seven-day rye loaves",
		});

		expect(await seoChecks(entry.id)).toEqual([
			// The title search engines get: the Post Type's pattern, the Site's name included.
			{ at: "seo.title", check: "seoTitleLong", params: { length: 79, max: 60 }, message: expect.any(String) },
			{ at: "seo.description", check: "seoDescriptionMissing", message: expect.any(String) },
			{ at: "seo.image", check: "seoImageMissing", message: expect.any(String) },
		]);
		expect(entry.problems).toEqual([]);
		const { entry: published } = await editor.api.entries.publish({ siteId, entryId: entry.id });
		expect(published.status).toBe("published");
	});

	test("measures the description it falls back to, and an own one too long or too short", async () => {
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Rye",
			fields: { body: [{ type: "paragraph", text: "Dense." }] },
		});
		expect((await seoChecks(entry.id)).map((check) => [check.check, check.params])).toContainEqual([
			"seoDescriptionShort",
			{ length: 6, min: 50 },
		]);

		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, seo: { description: `${sentence} ${sentence}` } });
		expect((await seoChecks(entry.id)).map((check) => [check.check, check.params])).toContainEqual([
			"seoDescriptionLong",
			{ length: 173, max: 160 },
		]);

		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, seo: { description: sentence } });
		expect((await seoChecks(entry.id)).map((check) => check.check)).not.toContain("seoDescriptionLong");
	});

	test("an image without alt text in the Entry's language is a warning, which goes once it has some", async () => {
		const cover = await image("cover.jpg");
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Spelt",
			fields: { cover },
			seo: { description: sentence },
		});
		expect(await seoChecks(entry.id)).toEqual([{ at: "seo.image", check: "seoImageAlt", message: expect.any(String) }]);

		await editor.api.media.update({ siteId, mediaId: cover, alt: "A spelt loaf" });
		expect(await seoChecks(entry.id)).toEqual([]);
		// French falls back to the Default language's alt text; its own can be checked in French.
		await editor.api.media.update({ siteId, mediaId: cover, language: "fr", alt: "" });
		expect(await seoChecks(entry.id, "fr")).toEqual([]);
	});

	test("the Site's default image counts as a social image", async () => {
		const shopfront = await image("shopfront.jpg", "The bakery's front");
		await staff.api.seoSettings.update({ siteId, defaultImage: shopfront });
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Buns",
			seo: { description: sentence },
		});

		expect(await seoChecks(entry.id)).toEqual([]);
		await staff.api.seoSettings.update({ siteId, defaultImage: null });
	});

	test("the Entry says what search engines get from its Draft, for the SEO card", async () => {
		const cover = await image("tart.jpg", "An apple tart");
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Apple tart",
			fields: { cover, body: [{ type: "paragraph", text: sentence }] },
		});

		expect(entry.seoPreview).toEqual({
			title: "Apple tart · Acme Bakery",
			description: sentence,
			image: { mediaId: cover, from: "field" },
		});
		const { entry: own } = await editor.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			seo: { title: "Apple tart, the classic", image: null },
		});
		expect(own.seoPreview).toMatchObject({
			title: "Apple tart, the classic",
			image: { mediaId: cover, from: "field" },
		});
	});
});
