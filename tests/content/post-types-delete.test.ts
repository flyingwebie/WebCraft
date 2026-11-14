// Deleting a Post Type: Structure, so Staff do it. It takes its Entries and its Entry and Archive
// templates with it, in two steps (the first says what would go), and is refused for the Page Post
// Type and while other Structure names it by its key.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let otherSiteId: string;
/** The Site's live origin, `https://bakery.live.test`. */
let origin: string;
let counter = 0;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	origin = await goLive(install, siteId);
	otherSiteId = (await install.createSite(workspaceId, { slug: "careers" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

/** A Post Type with a published Entry and a published Entry template and Archive template. */
async function team(name?: string) {
	const key = `team-${++counter}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: name ?? `Team ${counter}`,
		key,
		urlPattern: `/${key}/{slug}`,
	});
	const entries = [];
	for (const title of ["Ada", "Grace"]) {
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		entries.push(entry);
	}
	const entryTemplate = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: entryTemplate.template.id });
	await staff.api.templates.saveArchiveTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<section><h1>Our team</h1></section>",
	});
	return { postType, key, entries };
}

const page = (path: string) => install.request(`${origin}${path}`);

describe("deleting a Post Type", () => {
	test("the first call deletes nothing and says how many Entries and Templates would go", async () => {
		const { postType, key } = await team();

		const first = await staff.api.postTypes.delete({ siteId, postTypeId: postType.id });

		expect(first).toEqual({
			deleted: false,
			entries: 2,
			templates: 2,
			confirmation: { id: expect.any(String), expiresAt: expect.anything() },
		});
		expect((await staff.api.postTypes.get({ siteId, postTypeId: postType.id })).postType.key).toBe(key);
		expect((await page(`/${key}/ada`)).status).toBe(200);
	});

	test("the second call deletes it with its Entries and Templates, and its pages are gone", async () => {
		const { postType, key, entries } = await team();
		const { confirmation } = (await staff.api.postTypes.delete({ siteId, postTypeId: postType.id })) as {
			confirmation: { id: string };
		};

		const second = await staff.api.postTypes.delete({
			siteId,
			postTypeId: postType.id,
			confirmation: confirmation.id,
		});

		expect(second).toEqual({ deleted: true, entries: 2, templates: 2 });
		await expect(staff.api.postTypes.get({ siteId, postTypeId: postType.id })).rejects.toMatchObject({
			code: "POST_TYPE_NOT_FOUND",
		});
		expect((await staff.api.postTypes.list({ siteId })).postTypes.map((each) => each.id)).not.toContain(postType.id);
		await expect(staff.api.entries.get({ siteId, entryId: entries[0]?.id ?? "" })).rejects.toMatchObject({
			code: "ENTRY_NOT_FOUND",
		});
		const listed = (await staff.api.templates.list({ siteId })).templates;
		expect(listed.some((template) => template.postType?.id === postType.id)).toBe(false);
		expect((await page(`/${key}/ada`)).status).toBe(404);
	});

	test("is recorded in the Audit log with what went", async () => {
		const { postType, key } = await team("Bakers");
		const first = await staff.api.postTypes.delete({ siteId, postTypeId: postType.id });
		if (first.deleted) throw new Error("deleted on the first call");
		await staff.api.postTypes.delete({ siteId, postTypeId: postType.id, confirmation: first.confirmation.id });

		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "postType.delete",
			via: { kind: "admin" },
			siteId,
			details: { postTypeId: postType.id, key, name: "Bakers", entries: 2, templates: 2 },
		});
	});

	test("a confirmation no longer fits once its Entries change: nothing is deleted", async () => {
		const { postType } = await team();
		const first = await staff.api.postTypes.delete({ siteId, postTypeId: postType.id });
		if (first.deleted) throw new Error("deleted on the first call");
		await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Linus" });

		await expect(
			staff.api.postTypes.delete({ siteId, postTypeId: postType.id, confirmation: first.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
		expect((await staff.api.entries.list({ siteId, postTypeId: postType.id })).entries).toHaveLength(3);
	});

	test("a Post Type with no Entries and no Templates goes too", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Events", urlPattern: "/events/{slug}" });
		const first = await staff.api.postTypes.delete({ siteId, postTypeId: postType.id });
		expect(first).toMatchObject({ deleted: false, entries: 0, templates: 0 });
		if (first.deleted) throw new Error("deleted on the first call");

		await staff.api.postTypes.delete({ siteId, postTypeId: postType.id, confirmation: first.confirmation.id });
		expect((await staff.api.postTypes.list({ siteId })).postTypes.map((each) => each.id)).not.toContain(postType.id);
	});
});

describe("refused deletes", () => {
	test("the Page Post Type every Site has can't be deleted", async () => {
		const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page");

		await expect(staff.api.postTypes.delete({ siteId, postTypeId: pages?.id ?? "" })).rejects.toMatchObject({
			code: "POST_TYPE_BUILT_IN",
		});
	});

	test("Members can't delete a Post Type: it is Structure", async () => {
		const { postType } = await team();

		await expect(owner.api.postTypes.delete({ siteId, postTypeId: postType.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("a Post Type of another Site isn't found", async () => {
		const { postType } = await team();

		await expect(staff.api.postTypes.delete({ siteId: otherSiteId, postTypeId: postType.id })).rejects.toMatchObject({
			code: "POST_TYPE_NOT_FOUND",
		});
	});

	test("while another Post Type's Relationship, a Component's Prop or a Loop names it, it is in use", async () => {
		const { postType, key } = await team("Authors");
		const { postType: posts } = await staff.api.postTypes.create({
			siteId,
			name: "Articles",
			urlPattern: `/articles-${counter}/{slug}`,
			fields: [
				{
					key: "credits",
					label: "Credits",
					type: "group",
					fields: [{ key: "writer", label: "Writer", type: "relationship", postTypes: [key] }],
				},
			],
		});
		const { component } = await staff.api.components.create({ siteId, name: `Byline${counter}` });
		await staff.api.components.saveDraft({
			siteId,
			componentId: component.id,
			props: [{ key: "person", label: "Person", type: "relationship", postTypes: [key] }],
		});
		const { loop } = await staff.api.loops.create({
			siteId,
			name: `authors-${counter}`,
			source: "query",
			query: { postTypes: [key] },
		});

		await expect(staff.api.postTypes.delete({ siteId, postTypeId: postType.id })).rejects.toMatchObject({
			code: "POST_TYPE_IN_USE",
			data: {
				usedIn: [
					{ kind: "postType", id: posts.id, name: "Articles", path: "credits.writer" },
					{ kind: "component", id: component.id, name: component.name, path: "person" },
					{ kind: "loop", id: loop.id, name: loop.name },
				],
			},
		});
		expect((await staff.api.entries.list({ siteId, postTypeId: postType.id })).entries).toHaveLength(2);
	});

	test("a Relationship to its own Entries doesn't keep it", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [{ key: "related", label: "Related", type: "relationship", postTypes: ["recipes"] }],
		});

		const first = await staff.api.postTypes.delete({ siteId, postTypeId: postType.id });
		expect(first.deleted).toBe(false);
	});
});
