// Entries: one record of a Post Type. Every Entry has the built-in Fields (title, slug, status,
// author, dates) beside its Post Type's Fields, and a Draft and a published version.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let authorId: string;
let authorName: string;
let siteId: string;
let postTypeId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const created = await install.createMember({ workspaceId, role: "author", name: "Ada Author" });
	author = created.browser;
	authorId = created.personId;
	authorName = created.account.name;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "blog",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "sku", label: "SKU", type: "text", translatable: false },
		],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install.close();
});

describe("creating an Entry", () => {
	test("an Author writes one: it has the built-in Fields and a Draft, and nothing published yet", async () => {
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId,
			title: "  Sourdough starter  ",
			fields: { summary: "Feed it daily." },
		});

		expect(entry).toEqual({
			id: expect.any(String),
			siteId,
			postTypeId,
			status: "draft",
			author: { id: authorId, name: authorName },
			createdAt: install.clock.now(),
			updatedAt: install.clock.now(),
			publishedAt: null,
			lastPublishedAt: null,
			unpublishedAt: null,
			scheduled: { publish: null, unpublish: null },
			review: null,
			language: "en",
			draft: {
				title: "Sourdough starter",
				slug: "sourdough-starter",
				parentId: null,
				hiddenLanguages: [],
				fields: { summary: "Feed it daily.", sku: null },
				seo: { title: null, description: null, canonical: null, image: null, noindex: false },
			},
			published: null,
			path: null,
			problems: [],
			// The SEO check's warnings (see tests/seo): nothing to describe the page or show when it is shared.
			checks: [{ at: "seo.description", check: "seoDescriptionMissing", message: expect.any(String) }],
			seoPreview: {
				title: expect.stringMatching(/^Sourdough starter · Site \d+$/),
				description: null,
				image: { from: "socialCard", layout: "editorial", state: "onPublish" },
			},
			linkedFrom: [],
			// Translations stand only in a language other than the Default language.
			translation: null,
		});
		expect((await editor.api.entries.get({ siteId, entryId: entry.id })).entry).toEqual(entry);
	});

	test("its slug is made from the title, without accents, and kept unique within the Post Type", async () => {
		const first = await author.api.entries.create({ siteId, postTypeId, title: "Crème brûlée, 2 ways!" });
		const second = await author.api.entries.create({ siteId, postTypeId, title: "Crème Brûlée 2 Ways" });
		const symbols = await author.api.entries.create({ siteId, postTypeId, title: "!!!" });

		expect(first.entry.draft.slug).toBe("creme-brulee-2-ways");
		expect(second.entry.draft.slug).toBe("creme-brulee-2-ways-2");
		expect(symbols.entry.draft.slug).toBe("blog-posts");
	});

	test("a slug can be given; one another Entry of the Post Type has is refused", async () => {
		const { entry } = await author.api.entries.create({ siteId, postTypeId, title: "Rye", slug: "Rye-Bread" });
		expect(entry.draft.slug).toBe("rye-bread");

		expect(
			await rejection(author.api.entries.create({ siteId, postTypeId, title: "Rye again", slug: "rye-bread" })),
		).toMatchObject({ code: "ENTRY_SLUG_TAKEN", data: { slug: "rye-bread" } });
	});

	test("refuses a slug that isn't lower-case letters and digits joined by dashes", async () => {
		for (const slug of ["two words", "-rye", "rye-", "rye--bread", "rye/bread", "pão"]) {
			expect(await rejection(author.api.entries.create({ siteId, postTypeId, title: "Rye", slug }))).toMatchObject({
				code: "ENTRY_INVALID",
				data: { problems: [{ at: "slug" }] },
			});
		}
	});

	test("refuses values for Fields the Post Type doesn't have, and languages the Site doesn't have", async () => {
		expect(
			await rejection(author.api.entries.create({ siteId, postTypeId, title: "Rye", fields: { price: "4.50" } })),
		).toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "fields.price" }] } });
		expect(
			await rejection(author.api.entries.create({ siteId, postTypeId, title: "Rye", language: "it" })),
		).toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "language" }] } });
	});

	test("refuses an Entry without a title", async () => {
		expect(await rejection(author.api.entries.create({ siteId, postTypeId, title: "  " }))).toMatchObject({
			code: "BAD_REQUEST",
		});
	});
});

describe("the Draft and the published version", () => {
	test("saving the Draft changes only the Draft; publishing makes the Draft the published version", async () => {
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId,
			title: "Baguette",
			fields: { sku: "B-1" },
		});
		await install.clock.advance(60_000);
		const saved = await author.api.entries.saveDraft({ siteId, entryId: entry.id, fields: { summary: "Crisp." } });

		expect(saved.entry).toMatchObject({
			status: "draft",
			updatedAt: install.clock.now(),
			draft: { title: "Baguette", slug: "baguette", fields: { summary: "Crisp.", sku: "B-1" } },
			published: null,
		});

		await install.clock.advance(60_000);
		const firstPublish = install.clock.now();
		const { entry: published } = await editor.api.entries.publish({ siteId, entryId: entry.id });

		expect(published).toMatchObject({
			status: "published",
			publishedAt: firstPublish,
			lastPublishedAt: firstPublish,
			published: { title: "Baguette", slug: "baguette", fields: { summary: "Crisp.", sku: "B-1" } },
		});

		await install.clock.advance(60_000);
		const changed = await author.api.entries.saveDraft({ siteId, entryId: entry.id, title: "French baguette" });
		expect(changed.entry).toMatchObject({
			status: "changed",
			draft: { title: "French baguette" },
			published: { title: "Baguette" },
		});

		await install.clock.advance(60_000);
		const { entry: republished } = await editor.api.entries.publish({ siteId, entryId: entry.id });
		expect(republished).toMatchObject({
			status: "published",
			publishedAt: firstPublish,
			lastPublishedAt: install.clock.now(),
			published: { title: "French baguette", slug: "baguette" },
		});
	});

	test("the slug stays as it is when the title changes", async () => {
		const { entry } = await author.api.entries.create({ siteId, postTypeId, title: "Focaccia" });

		const saved = await author.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Rosemary focaccia" });

		expect(saved.entry.draft.slug).toBe("focaccia");
	});

	test("a value can be cleared, and an unchanged value doesn't change the status", async () => {
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId,
			title: "Brioche",
			fields: { summary: "Rich." },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		const same = await author.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Brioche" });
		expect(same.entry.status).toBe("published");

		const cleared = await author.api.entries.saveDraft({ siteId, entryId: entry.id, fields: { summary: null } });
		expect(cleared.entry).toMatchObject({ status: "changed", draft: { fields: { summary: null } } });
	});

	test("lists a Post Type's Entries, newest first", async () => {
		await install.clock.advance(60_000);
		const { entry: newest } = await author.api.entries.create({ siteId, postTypeId, title: "Ciabatta" });

		const { entries } = await editor.api.entries.list({ siteId, postTypeId });

		expect(entries[0]).toEqual(newest);
		expect(entries.map((entry) => entry.draft.title)).toContain("Sourdough starter");
	});

	test("an Entry of another Site can't be reached through this Site", async () => {
		const otherSiteId = (await install.createSite((await install.createWorkspace()).id)).id;
		const admin = await install.superadmin();
		const { postType } = await admin.api.postTypes.create({
			siteId: otherSiteId,
			name: "Notes",
			urlPattern: "/n/{slug}",
		});
		const { entry } = await admin.api.entries.create({ siteId: otherSiteId, postTypeId: postType.id, title: "Secret" });

		expect(await rejection(admin.api.entries.get({ siteId, entryId: entry.id }))).toMatchObject({
			code: "ENTRY_NOT_FOUND",
		});
		expect(await rejection(admin.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Changed" }))).toMatchObject(
			{
				code: "ENTRY_NOT_FOUND",
			},
		);
		expect(await rejection(admin.api.entries.publish({ siteId, entryId: entry.id }))).toMatchObject({
			code: "ENTRY_NOT_FOUND",
		});
		expect(
			await rejection(admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Into the wrong Site" })),
		).toMatchObject({ code: "POST_TYPE_NOT_FOUND" });
	});
});
