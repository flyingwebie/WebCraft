// SEO fields (GLOSSARY.md): every Entry, Pages included, has an SEO title, description, canonical
// URL, noindex and social image. They are part of its Draft and publish with it; each is
// Translatable except noindex, one value for every language (ADR 0003).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
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

async function newSite(languages: string[] = []): Promise<{ siteId: string; postTypeId: string; origin: string }> {
	const slug = `seo-fields-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	return { siteId, postTypeId: postType.id, origin: `https://${slug}.sites.test` };
}

/** Uploads an image to a Site's Media library and lets the worker make it ready. */
async function uploadImage(siteId: string, name = "loaf.jpg"): Promise<string> {
	const bytes = await photo({ width: 1600, height: 900, format: "jpeg" });
	const { media } = await editor.api.media.upload({ siteId, file: upload(bytes, name, "image/jpeg") });
	await install.drainJobs();
	return media.id;
}

describe("SEO fields", () => {
	test("they save with the Draft, each in its language, while noindex is one value for every language", async () => {
		const { siteId, postTypeId } = await newSite(["fr"]);
		const imageId = await uploadImage(siteId);
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Fresh bread" });

		await editor.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			seo: {
				title: "Fresh sourdough every morning",
				description: "Our loaves, out of the oven at seven.",
				canonical: "/blog/bread",
				image: imageId,
				noindex: true,
			},
		});
		await editor.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			language: "fr",
			seo: { title: "Du pain frais chaque matin", noindex: false },
		});

		const english = (await editor.api.entries.get({ siteId, entryId: entry.id })).entry;
		expect(english.draft.seo).toEqual({
			title: "Fresh sourdough every morning",
			description: "Our loaves, out of the oven at seven.",
			canonical: "/blog/bread",
			image: imageId,
			noindex: false,
		});
		const french = (await editor.api.entries.get({ siteId, entryId: entry.id, language: "fr" })).entry;
		// A language without its own value shows the Default language's, one SEO field at a time.
		expect(french.draft.seo).toEqual({
			title: "Du pain frais chaque matin",
			description: "Our loaves, out of the oven at seven.",
			canonical: "/blog/bread",
			image: imageId,
			noindex: false,
		});
		// Nothing is published yet.
		expect(english.published).toBeNull();
	});

	test("a new Entry has empty SEO fields, and null or an empty text clears one", async () => {
		const { siteId, postTypeId } = await newSite();
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Rye",
			seo: { title: "Dark rye", description: "Heavy and sour." },
		});
		expect(entry.draft.seo).toEqual({
			title: "Dark rye",
			description: "Heavy and sour.",
			canonical: null,
			image: null,
			noindex: false,
		});

		const { entry: cleared } = await editor.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			seo: { title: null, description: "" },
		});
		expect(cleared.draft.seo).toEqual({ title: null, description: null, canonical: null, image: null, noindex: false });
	});

	test("they publish with the Entry, and a change after publishing is a change to its Draft", async () => {
		const { siteId, postTypeId } = await newSite();
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Spelt", seo: { title: "Spelt" } });
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		const { entry: changed } = await editor.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			seo: { title: "Spelt, the old grain" },
		});

		expect(changed.status).toBe("changed");
		expect(changed.published?.seo.title).toBe("Spelt");
		expect(changed.draft.seo.title).toBe("Spelt, the old grain");
	});

	test("Authors edit SEO fields as Content", async () => {
		const { siteId, postTypeId } = await newSite();
		const { entry } = await author.api.entries.create({ siteId, postTypeId, title: "Buns" });

		const { entry: saved } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			seo: { description: "Soft, sweet and glazed.", noindex: true },
		});

		expect(saved.draft.seo.description).toBe("Soft, sweet and glazed.");
		expect(saved.draft.seo.noindex).toBe(true);
	});

	test("a canonical URL is an http or https address, or a path on the Site", async () => {
		const { siteId, postTypeId } = await newSite();
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Rolls" });

		for (const canonical of ["https://example.org/rolls", "http://example.org/rolls", "/bakery/rolls"]) {
			const { entry: saved } = await editor.api.entries.saveDraft({ siteId, entryId: entry.id, seo: { canonical } });
			expect(saved.draft.seo.canonical).toBe(canonical);
		}
		for (const canonical of ["javascript:alert(1)", "//example.org/rolls", "rolls", "https://", "data:text/html,x"]) {
			const refused = await editor.api.entries
				.saveDraft({ siteId, entryId: entry.id, seo: { canonical } })
				.catch((error: { code: string; data: { problems: { at: string }[] } }) => error);
			expect(refused).toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "seo.canonical" }] } });
		}
	});

	test("the social image is an image of the Site's Media library, never a file in the Trash", async () => {
		const { siteId, postTypeId } = await newSite();
		const other = await newSite();
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Croissants" });
		const elsewhere = await uploadImage(other.siteId);
		const { media: document } = await editor.api.media.upload({
			siteId,
			file: upload(new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), "menu.pdf", "application/pdf"),
		});
		const trashed = await uploadImage(siteId, "old.jpg");
		const first = await editor.api.media.delete({ siteId, mediaId: trashed });
		if (first.trashed) throw new Error("It should ask first.");
		await editor.api.media.delete({ siteId, mediaId: trashed, confirmation: first.confirmation.id });

		for (const image of [elsewhere, document.id, trashed, "not-an-id"]) {
			const refused = await editor.api.entries
				.saveDraft({ siteId, entryId: entry.id, seo: { image } })
				.catch((error: { code: string; data?: { problems: { at: string }[] } }) => error);
			expect(refused).toMatchObject({ code: expect.stringMatching(/ENTRY_INVALID|BAD_REQUEST/) });
		}
		const after = (await editor.api.entries.get({ siteId, entryId: entry.id })).entry;
		expect(after.draft.seo.image).toBeNull();
	});

	test("noindex can't be given per language: it is one value for the Entry", async () => {
		const { siteId, postTypeId } = await newSite(["fr"]);
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Tarts" });

		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, language: "fr", seo: { noindex: true } });

		expect((await editor.api.entries.get({ siteId, entryId: entry.id })).entry.draft.seo.noindex).toBe(true);
		expect((await editor.api.entries.get({ siteId, entryId: entry.id, language: "fr" })).entry.draft.seo.noindex).toBe(
			true,
		);
	});

	test("noindex stays the Entry's one value when the Default language changes", async () => {
		const { siteId, postTypeId } = await newSite(["fr"]);
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Brioche",
			seo: { title: "Butter brioche", noindex: true },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		const asked = await staff.api.languages.setDefault({ siteId, code: "fr" });
		if (asked.changed) throw new Error("It should ask first.");
		await staff.api.languages.setDefault({ siteId, code: "fr", confirmation: asked.confirmation.id });

		const french = (await editor.api.entries.get({ siteId, entryId: entry.id, language: "fr" })).entry;
		expect(french.draft.seo.noindex).toBe(true);
		expect(french.published?.seo.noindex).toBe(true);
		// The English SEO title is still English's own.
		const english = (await editor.api.entries.get({ siteId, entryId: entry.id, language: "en" })).entry;
		expect(english.draft.seo.title).toBe("Butter brioche");
	});

	test("no Field of a Post Type can take the key seo, which the SEO fields keep", async () => {
		const { siteId } = await newSite();

		const refused = await staff.api.postTypes
			.create({
				siteId,
				name: "Recipes",
				urlPattern: "/recipes/{slug}",
				fields: [{ key: "seo", label: "SEO", type: "text" }],
			})
			.catch((error: unknown) => error);

		expect(refused).toMatchObject({
			code: "POST_TYPE_INVALID",
			data: { problems: [{ at: "fields[0].key", rule: "keyReserved" }] },
		});
	});
});
