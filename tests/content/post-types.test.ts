// Post Types: the kinds of Entry a Site holds, each with a URL pattern and Fields. They are
// Structure: Staff (and the Superadmin) change them; Members read them to write Entries.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { element, tree, value } from "../harness/trees.ts";

const BUILT_IN_FIELDS = [
	"title",
	"slug",
	"status",
	"author",
	"createdAt",
	"updatedAt",
	"publishedAt",
	"lastPublishedAt",
] as const;

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let otherSiteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	otherSiteId = (await install.createSite(workspaceId, { slug: "careers" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("creating a Post Type", () => {
	test("Staff create one with a URL pattern and a text Field; every Entry also has the built-in Fields", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: " Blog posts ",
			key: "blog",
			urlPattern: "/blog/{slug}",
			fields: [{ key: "summary", label: "Summary", type: "text" }],
		});

		expect(postType).toEqual({
			id: expect.any(String),
			siteId,
			key: "blog",
			name: "Blog posts",
			urlPattern: "/blog/{slug}",
			fields: [
				{
					key: "summary",
					label: "Summary",
					type: "text",
					help: "",
					translatable: true,
					required: false,
					default: null,
					minLength: null,
					maxLength: null,
					pattern: null,
				},
			],
			builtInFields: BUILT_IN_FIELDS,
			createdAt: install.clock.now(),
			updatedAt: install.clock.now(),
		});
		expect((await staff.api.postTypes.get({ siteId, postTypeId: postType.id })).postType).toEqual(postType);
		expect((await staff.api.postTypes.list({ siteId })).postTypes).toContainEqual(postType);
	});

	test("its key is made from its name when not given", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Team Members", urlPattern: "/team/{slug}" });

		expect(postType.key).toBe("team-members");
		expect(postType.fields).toEqual([]);
	});

	test("Fields can be shared by every language, and required", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Products",
			urlPattern: "/shop/products/{slug}",
			fields: [
				{ key: "sku", label: "SKU", type: "text", translatable: false, required: true },
				{ key: "tagline", label: "Tagline", type: "text" },
			],
		});

		expect(postType.fields).toEqual([
			expect.objectContaining({ key: "sku", label: "SKU", type: "text", translatable: false, required: true }),
			expect.objectContaining({ key: "tagline", label: "Tagline", type: "text", translatable: true, required: false }),
		]);
	});

	test("Members see a Site's Post Types, to write Entries, but can't create them", async () => {
		expect((await owner.api.postTypes.list({ siteId })).postTypes.map((postType) => postType.key)).toContain("blog");

		await expect(
			owner.api.postTypes.create({ siteId, name: "Events", urlPattern: "/events/{slug}" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("is recorded in the Audit log", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Recipes", urlPattern: "/recipes/{slug}" });

		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "postType.create",
			via: { kind: "admin" },
			siteId,
			details: { postTypeId: postType.id, key: "recipes", name: "Recipes", urlPattern: "/recipes/{slug}" },
		});
	});
});

describe("refused Post Types", () => {
	test("URL patterns need fixed parts and exactly one {slug}", async () => {
		const refused = [
			"blog/{slug}",
			"/blog/{slug}/",
			"/blog",
			"/{slug}/{slug}",
			"/Blog/{slug}",
			"/_media/{slug}",
			"/a b/{slug}",
			"/blog/{id}",
		];
		for (const urlPattern of refused) {
			await expect(staff.api.postTypes.create({ siteId, name: "Bad", urlPattern })).rejects.toMatchObject({
				code: "POST_TYPE_INVALID",
				data: { problems: [{ at: "urlPattern" }] },
			});
		}
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Pages", urlPattern: "/{slug}" });
		expect(postType.urlPattern).toBe("/{slug}");
	});

	test("Field keys must be names, unique, and not one WebCraft keeps", async () => {
		const cases = [
			{ key: "Summary", at: "fields[0].key" },
			{ key: "2nd", at: "fields[0].key" },
			{ key: "title", at: "fields[0].key" },
			{ key: "publishedAt", at: "fields[0].key" },
			{ key: "site", at: "fields[0].key" },
			// Words Conditions' tests use: {{@if not summary}} must read the same way.
			{ key: "not", at: "fields[0].key" },
			{ key: "true", at: "fields[0].key" },
		];
		for (const { key, at } of cases) {
			await expect(
				staff.api.postTypes.create({
					siteId,
					name: "Bad",
					urlPattern: "/bad/{slug}",
					fields: [{ key, label: "Label", type: "text" }],
				}),
			).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at }] } });
		}
		await expect(
			staff.api.postTypes.create({
				siteId,
				name: "Bad",
				urlPattern: "/bad/{slug}",
				fields: [
					{ key: "intro", label: "Intro", type: "text" },
					{ key: "intro", label: "Intro again", type: "text" },
				],
			}),
		).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at: "fields[1].key" }] } });
	});

	test("a Post Type needs a name and a key", async () => {
		await expect(staff.api.postTypes.create({ siteId, name: " ", urlPattern: "/x/{slug}" })).rejects.toMatchObject({
			code: "POST_TYPE_INVALID",
		});
		await expect(
			staff.api.postTypes.create({ siteId, name: "Events", key: "Events!", urlPattern: "/x/{slug}" }),
		).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at: "key" }] } });
	});

	test("two Post Types of a Site can't share a key or a URL pattern; another Site's can", async () => {
		await expect(
			staff.api.postTypes.create({ siteId, name: "News", key: "blog", urlPattern: "/news/{slug}" }),
		).rejects.toMatchObject({ code: "POST_TYPE_TAKEN", data: { field: "key" } });
		await expect(
			staff.api.postTypes.create({ siteId, name: "News", key: "news", urlPattern: "/blog/{slug}" }),
		).rejects.toMatchObject({ code: "POST_TYPE_TAKEN", data: { field: "urlPattern" } });

		const { postType } = await staff.api.postTypes.create({
			siteId: otherSiteId,
			name: "Blog posts",
			key: "blog",
			urlPattern: "/blog/{slug}",
		});
		expect(postType.siteId).toBe(otherSiteId);
	});

	test("a Post Type of another Site can't be reached through this Site", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId: otherSiteId,
			name: "Jobs",
			urlPattern: "/jobs/{slug}",
		});

		await expect(staff.api.postTypes.get({ siteId, postTypeId: postType.id })).rejects.toMatchObject({
			code: "POST_TYPE_NOT_FOUND",
		});
		await expect(staff.api.postTypes.update({ siteId, postTypeId: postType.id, name: "Stolen" })).rejects.toMatchObject(
			{ code: "POST_TYPE_NOT_FOUND" },
		);
	});
});

describe("changing a Post Type", () => {
	test("applies at once: a new URL pattern moves its published Entries, without a publish", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Stories",
			urlPattern: "/stories/{slug}",
			fields: [{ key: "intro", label: "Intro", type: "text" }],
		});
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(element("h1", [value("title")])),
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Our oven" });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		expect((await install.request("https://bakery.sites.test/stories/our-oven")).status).toBe(200);

		const { postType: changed } = await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			name: "Our stories",
			urlPattern: "/journal/{slug}",
		});

		expect(changed).toMatchObject({ key: postType.key, name: "Our stories", urlPattern: "/journal/{slug}" });
		expect((await install.request("https://bakery.sites.test/stories/our-oven")).status).toBe(404);
		const moved = await install.request("https://bakery.sites.test/journal/our-oven");
		expect(moved.status).toBe(200);
		expect(moved.headers.get("x-cache")).toBe("MISS");
	});

	test("Fields can be added, relabelled, reordered and removed; a Field type that doesn't exist is refused", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Courses",
			urlPattern: "/courses/{slug}",
			fields: [{ key: "level", label: "Level", type: "text" }],
		});

		const { postType: changed } = await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			fields: [
				{ key: "duration", label: "Duration", type: "text", required: true },
				{ key: "level", label: "Difficulty", type: "text" },
			],
		});

		expect(changed.fields.map((field) => [field.key, field.label])).toEqual([
			["duration", "Duration"],
			["level", "Difficulty"],
		]);
		await expect(
			staff.api.postTypes.update({
				siteId,
				postTypeId: postType.id,
				// @ts-expect-error: a type no Field has, as a client could send it
				fields: [{ key: "level", label: "Level", type: "colour" }],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("Members can't change one", async () => {
		const { postTypes } = await owner.api.postTypes.list({ siteId });
		const postTypeId = postTypes[0]?.id ?? "";

		await expect(owner.api.postTypes.update({ siteId, postTypeId, name: "Renamed" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
