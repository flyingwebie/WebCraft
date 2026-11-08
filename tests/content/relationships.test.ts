// Relationships: a Field that points at Entries of chosen Post Types. Two-way by default (the Entries
// pointed at show the link back), one-way when Staff choose. Categories and tags are ordinary Post
// Types joined by Relationships. Deleting an Entry asks to confirm how many links it removes, then
// removes them on both sides; a required Relationship blocks the delete.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { element, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let author: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let otherSiteId: string;
const postTypeIds: Record<"categories" | "tags" | "people" | "blog" | "recipes", string> = {
	categories: "",
	tags: "",
	people: "",
	blog: "",
	recipes: "",
};

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	otherSiteId = (await install.createSite(workspaceId, { slug: "careers" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	for (const [key, name] of [
		["categories", "Categories"],
		["tags", "Tags"],
		["people", "People"],
	] as const) {
		postTypeIds[key] = (
			await staff.api.postTypes.create({ siteId, name, key, urlPattern: `/${key}/{slug}` })
		).postType.id;
	}
	postTypeIds.blog = (
		await staff.api.postTypes.create({
			siteId,
			name: "Blog posts",
			key: "blog",
			urlPattern: "/blog/{slug}",
			fields: [
				{ key: "categories", label: "Categories", type: "relationship", postTypes: ["categories"], multiple: true },
				{ key: "tags", label: "Tags", type: "relationship", postTypes: ["tags"], multiple: true, twoWay: false },
				{ key: "writer", label: "Writer", type: "relationship", postTypes: ["people"] },
				{
					key: "credits",
					label: "Credits",
					type: "repeater",
					fields: [{ key: "person", label: "Person", type: "relationship", postTypes: ["people"] }],
				},
			],
		})
	).postType.id;
	postTypeIds.recipes = (
		await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [{ key: "chef", label: "Chef", type: "relationship", postTypes: ["people"], required: true }],
		})
	).postType.id;
	const { template } = await staff.api.templates.saveEntryTemplate({
		siteId,
		postTypeId: postTypeIds.blog,
		tree: tree(element("h1", [value("title")]), element("p", [value("tags")])),
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
});

afterAll(async () => {
	await install.close();
});

/** A new Entry of a Post Type, written by the Author. */
async function entryOf(postType: keyof typeof postTypeIds, title: string, fields?: Record<string, unknown>) {
	return (await author.api.entries.create({ siteId, postTypeId: postTypeIds[postType], title, fields })).entry;
}

describe("defining a Relationship", () => {
	test("it points at Post Types by key, two-way unless made one-way, and is shared by every language", async () => {
		const { postType } = await staff.api.postTypes.get({ siteId, postTypeId: postTypeIds.blog });

		expect(postType.fields.slice(0, 3)).toEqual([
			{
				key: "categories",
				label: "Categories",
				type: "relationship",
				help: "",
				required: false,
				translatable: false,
				default: null,
				postTypes: ["categories"],
				multiple: true,
				twoWay: true,
				min: null,
				max: null,
			},
			expect.objectContaining({ key: "tags", twoWay: false }),
			expect.objectContaining({ key: "writer", multiple: false, twoWay: true }),
		]);
	});

	test("refuses Post Types the Site doesn't have, a translatable Relationship and a default", async () => {
		const cases: { field: Record<string, unknown>; at: string }[] = [
			{ field: { postTypes: ["events"] }, at: "fields[0].postTypes[0]" },
			{ field: { postTypes: [] }, at: "fields[0].postTypes" },
			{ field: { postTypes: ["tags"], translatable: true }, at: "fields[0].translatable" },
			{ field: { postTypes: ["tags"], default: "x" }, at: "fields[0].default" },
			{ field: { postTypes: ["tags"], min: 1 }, at: "fields[0].min" },
		];
		for (const { field, at } of cases) {
			await expect(
				staff.api.postTypes.create({
					siteId,
					name: "Bad",
					urlPattern: "/bad/{slug}",
					fields: [{ key: "links", label: "Links", type: "relationship", ...field }],
				}),
			).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at }] } });
		}
		// A Post Type may point at its own Entries.
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Pages",
			key: "pages",
			urlPattern: "/{slug}",
			fields: [{ key: "parent", label: "Parent", type: "relationship", postTypes: ["pages"] }],
		});
		expect(postType.fields[0]).toMatchObject({ postTypes: ["pages"] });
	});
});

describe("values", () => {
	test("a Relationship holds Entry ids of its Post Types, one or a list", async () => {
		const bread = await entryOf("categories", "Bread");
		const cakes = await entryOf("categories", "Cakes");
		const ada = await entryOf("people", "Ada");

		const post = await entryOf("blog", "Rye", { categories: [bread.id, cakes.id, bread.id], writer: ada.id });

		expect(post.draft.fields).toMatchObject({
			categories: [bread.id, cakes.id],
			tags: [],
			writer: ada.id,
			credits: [],
		});
	});

	test("refuses Entries of other Post Types, of other Sites, and ids that are no Entry's", async () => {
		const tag = await entryOf("tags", "Seasonal");
		const elsewhere = await admin.api.postTypes.create({
			siteId: otherSiteId,
			name: "Jobs",
			key: "categories",
			urlPattern: "/jobs/{slug}",
		});
		const job = (
			await admin.api.entries.create({ siteId: otherSiteId, postTypeId: elsewhere.postType.id, title: "Baker" })
		).entry;
		const post = await entryOf("blog", "Spelt");

		for (const fields of [
			{ categories: [tag.id] },
			{ categories: [job.id] },
			{ categories: ["0b0c8a4e-9a51-4a31-9d6c-2c1c1b1e9f00"] },
			{ categories: ["not an id"] },
			{ writer: [tag.id] },
		]) {
			const [key] = Object.keys(fields);
			await expect(
				author.api.entries.saveDraft({ siteId, entryId: post.id, fields }),
				JSON.stringify(fields),
			).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: `fields.${key}` }] } });
		}
		const credit = author.api.entries.saveDraft({
			siteId,
			entryId: post.id,
			fields: { credits: [{ person: tag.id }] },
		});
		await expect(credit).rejects.toMatchObject({ data: { problems: [{ at: "fields.credits[0].person" }] } });
	});
});

describe("the link back", () => {
	test("Entries pointed at through a two-way Relationship show the Entries pointing at them", async () => {
		const pastry = await entryOf("categories", "Pastry");
		const bea = await entryOf("people", "Bea");
		const croissant = await entryOf("blog", "Croissant", { categories: [pastry.id], credits: [{ person: bea.id }] });
		const danish = await entryOf("blog", "Danish", { categories: [pastry.id] });

		const { entry } = await editor.api.entries.get({ siteId, entryId: pastry.id });
		expect(entry.linkedFrom).toEqual([
			{ entryId: croissant.id, postTypeId: postTypeIds.blog, field: "categories", title: "Croissant" },
			{ entryId: danish.id, postTypeId: postTypeIds.blog, field: "categories", title: "Danish" },
		]);
		expect((await editor.api.entries.get({ siteId, entryId: bea.id })).entry.linkedFrom).toEqual([
			{ entryId: croissant.id, postTypeId: postTypeIds.blog, field: "credits.person", title: "Croissant" },
		]);

		await author.api.entries.saveDraft({ siteId, entryId: danish.id, fields: { categories: [] } });
		expect(
			(await editor.api.entries.get({ siteId, entryId: pastry.id })).entry.linkedFrom.map((link) => link.title),
		).toEqual(["Croissant"]);
	});

	test("a one-way Relationship shows nothing on the Entries it points at", async () => {
		const tag = await entryOf("tags", "Vegan");
		await entryOf("blog", "Oat loaf", { tags: [tag.id] });

		expect((await editor.api.entries.get({ siteId, entryId: tag.id })).entry.linkedFrom).toEqual([]);
	});
});

describe("deleting an Entry", () => {
	test("first answers how many Entries link to it, then removes it and the links on both sides", async () => {
		const tag = await entryOf("tags", "Sourdough");
		const kept = await entryOf("tags", "Rustic");
		for (const shown of [tag, kept]) await editor.api.entries.publish({ siteId, entryId: shown.id });
		const draftOnly = await entryOf("blog", "Starter", { tags: [tag.id, kept.id] });
		const live = await entryOf("blog", "Country loaf", { tags: [kept.id, tag.id] });
		await editor.api.entries.publish({ siteId, entryId: live.id });
		const page = async () => (await install.request("https://bakery.sites.test/blog/country-loaf")).text();
		expect(await page()).toContain("<p>Rustic, Sourdough</p>");

		const asked = await editor.api.entries.delete({ siteId, entryId: tag.id });
		expect(asked).toEqual({
			deleted: false,
			links: 2,
			confirmation: { id: expect.any(String), expiresAt: new Date(install.clock.now().getTime() + 5 * 60_000) },
		});
		expect((await editor.api.entries.get({ siteId, entryId: tag.id })).entry.id).toBe(tag.id);

		const done = await editor.api.entries.delete({ siteId, entryId: tag.id, confirmation: asked.confirmation?.id });
		expect(done).toEqual({ deleted: true, links: 2 });
		await expect(editor.api.entries.get({ siteId, entryId: tag.id })).rejects.toMatchObject({
			code: "ENTRY_NOT_FOUND",
		});
		expect((await editor.api.entries.get({ siteId, entryId: draftOnly.id })).entry.draft.fields.tags).toEqual([
			kept.id,
		]);
		const { entry: liveNow } = await editor.api.entries.get({ siteId, entryId: live.id });
		expect(liveNow).toMatchObject({
			status: "published",
			draft: { fields: { tags: [kept.id] } },
			published: { fields: { tags: [kept.id] } },
		});
		expect(await page()).toContain("<p>Rustic</p>");
	});

	test("an Entry nothing links to is deleted after confirming no links; its page goes", async () => {
		const post = await entryOf("blog", "Brioche");
		await editor.api.entries.publish({ siteId, entryId: post.id });

		const asked = await editor.api.entries.delete({ siteId, entryId: post.id });
		expect(asked).toMatchObject({ deleted: false, links: 0 });
		await editor.api.entries.delete({ siteId, entryId: post.id, confirmation: asked.confirmation?.id });

		expect((await install.request("https://bakery.sites.test/blog/brioche")).status).toBe(404);
		const [audit] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(audit).toMatchObject({
			action: "entry.delete",
			siteId,
			details: { entryId: post.id, title: "Brioche", links: 0 },
		});
	});

	test("a required Relationship blocks the delete until it points elsewhere", async () => {
		const cal = await entryOf("people", "Cal");
		const dee = await entryOf("people", "Dee");
		const recipe = await entryOf("recipes", "Scones", { chef: cal.id });

		await expect(editor.api.entries.delete({ siteId, entryId: cal.id })).rejects.toMatchObject({
			code: "ENTRY_LINKED",
			data: { blockedBy: [{ entryId: recipe.id, postTypeId: postTypeIds.recipes, title: "Scones", fields: ["chef"] }] },
		});

		await author.api.entries.saveDraft({ siteId, entryId: recipe.id, fields: { chef: dee.id } });
		const asked = await editor.api.entries.delete({ siteId, entryId: cal.id });
		expect(asked).toMatchObject({ deleted: false, links: 0 });
	});

	test("a confirmation works once, for 5 minutes, for its own person and Entry, while nothing changed", async () => {
		const tag = await entryOf("tags", "Rye");
		const other = await entryOf("tags", "Wheat");
		const asked = await editor.api.entries.delete({ siteId, entryId: tag.id });
		const id = asked.confirmation?.id;

		await expect(editor.api.entries.delete({ siteId, entryId: other.id, confirmation: id })).rejects.toMatchObject({
			code: "CONFIRMATION_INVALID",
			data: { problem: "unknown" },
		});
		await expect(staff.api.entries.delete({ siteId, entryId: tag.id, confirmation: id })).rejects.toMatchObject({
			code: "CONFIRMATION_INVALID",
			data: { problem: "unknown" },
		});

		await entryOf("blog", "Rye bread", { tags: [tag.id] });
		await expect(editor.api.entries.delete({ siteId, entryId: tag.id, confirmation: id })).rejects.toMatchObject({
			code: "CONFIRMATION_INVALID",
			data: { problem: "changed" },
		});

		const again = await editor.api.entries.delete({ siteId, entryId: tag.id });
		install.clock.advance(5 * 60_000 + 1);
		await expect(
			editor.api.entries.delete({ siteId, entryId: tag.id, confirmation: again.confirmation?.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "expired" } });

		const last = await editor.api.entries.delete({ siteId, entryId: tag.id });
		await editor.api.entries.delete({ siteId, entryId: tag.id, confirmation: last.confirmation?.id });
		await expect(
			editor.api.entries.delete({ siteId, entryId: other.id, confirmation: last.confirmation?.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
	});

	test("Authors can't delete Entries", async () => {
		const tag = await entryOf("tags", "Mine");

		await expect(author.api.entries.delete({ siteId, entryId: tag.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { permission: "entry.delete" },
		});
	});
});
