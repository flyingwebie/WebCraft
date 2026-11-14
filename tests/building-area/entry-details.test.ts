// The Entry panel's and Page details' ground on the server (ADR 0037, BA-13): from the building area,
// `details/save` changes the page's Entry's other Fields too (a choice, a Relationship, a date, a
// number, a switch, a file, a Group's text), each in the page's language where it is translatable,
// through the same `saveDraft` as the admin: its refusals and problems are the same. A Body is the
// block editor's, never changed here. It is Content: Members, Authors included, change them; nobody
// reaches another Site's Entry.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type BuildingAreaBrowser, openBuildingArea } from "../harness/building-area.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let workspaceId: string;
let siteId: string;
let postTypeId: string;
let entryId: string;
let writerId: string;
let photoId: string;
let area: BuildingAreaBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await staff.api.languages.add({ siteId, code: "it" });
	const { postType: team } = await staff.api.postTypes.create({
		siteId,
		name: "Team",
		urlPattern: "/team/{slug}",
		fields: [],
	});
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "body", label: "Article", type: "body" },
			{ key: "excerpt", label: "Excerpt", type: "text", translatable: true },
			{
				key: "category",
				label: "Category",
				type: "select",
				options: [
					{ value: "baking", label: "Baking" },
					{ value: "recipes", label: "Recipes" },
				],
			},
			{ key: "writer", label: "Author", type: "relationship", postTypes: [team.key] },
			{ key: "day", label: "Date", type: "date" },
			{ key: "minutes", label: "Reading time", type: "number", integer: true },
			{ key: "featured", label: "Featured", type: "boolean" },
			{ key: "cover", label: "Cover image", type: "media" },
			{ key: "kicker", label: "Kicker", type: "text", required: true },
			{
				key: "credits",
				label: "Credits",
				type: "group",
				fields: [{ key: "photographer", label: "Photographer", type: "text" }],
			},
		],
	});
	postTypeId = postType.id;
	writerId = (await staff.api.entries.create({ siteId, postTypeId: team.id, title: "Priya Shah" })).entry.id;
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId,
		title: "Our sourdough starter",
		fields: { kicker: "Recipes" },
	});
	entryId = entry.id;
	await staff.api.entries.publish({ siteId, entryId });
	const { media } = await staff.api.media.upload({
		siteId,
		file: upload(await photo({ width: 400, height: 300 }), "starter.jpg"),
	});
	await install.drainJobs();
	photoId = media.id;
	area = await openBuildingArea(install, editor, siteId, { open: "/page/blog/our-sourdough-starter" });
});

afterAll(async () => {
	await install.close();
});

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

async function draftOf(id: string, language?: string) {
	return (await staff.api.entries.get({ siteId, entryId: id, ...(language ? { language } : {}) })).entry;
}

describe("the Fields that don't show on the page", () => {
	test("each kind saves to the Draft as the admin saves it; visitors see the published page", async () => {
		const response = await area.edit("details/save", {
			item: `entry:${entryId}`,
			fields: {
				category: "recipes",
				writer: writerId,
				day: "2026-03-03",
				minutes: 6,
				featured: true,
				cover: photoId,
				credits: { photographer: "Giulia Romano" },
			},
		});

		expect(response.status).toBe(200);
		expect(await json(response)).toMatchObject({ details: { item: `entry:${entryId}` }, problems: [] });
		const entry = await draftOf(entryId);
		expect(entry.draft.fields).toMatchObject({
			category: "recipes",
			writer: writerId,
			day: "2026-03-03",
			minutes: 6,
			featured: true,
			cover: photoId,
			credits: { photographer: "Giulia Romano" },
		});
		expect(entry.published?.fields.category ?? null).toBeNull();
		expect(entry.status).toBe("changed");
	});

	test("a translatable value is the page's language's; a shared one is every language's", async () => {
		await area.edit("details/save", {
			item: `entry:${entryId}`,
			language: "it",
			fields: { excerpt: "Dodici anni di lievito madre.", category: "baking" },
		});

		expect((await draftOf(entryId, "it")).draft.fields).toMatchObject({
			excerpt: "Dodici anni di lievito madre.",
			category: "baking",
		});
		const english = await draftOf(entryId, "en");
		expect(english.draft.fields.excerpt ?? null).toBeNull();
		expect(english.draft.fields.category).toBe("baking");
	});

	test("an emptied required value is a problem of that Field, said in the answer", async () => {
		const response = await area.edit("details/save", { item: `entry:${entryId}`, fields: { kicker: "" } });

		expect(response.status).toBe(200);
		expect((await json(response)).problems).toEqual([expect.objectContaining({ at: "fields.kicker", rule: "required" })]);
		await area.edit("details/save", { item: `entry:${entryId}`, fields: { kicker: "Recipes" } });
	});

	test("a value its Field doesn't take is refused, and nothing changes", async () => {
		const response = await area.edit("details/save", {
			item: `entry:${entryId}`,
			fields: { category: "cakes", minutes: 3 },
		});

		expect({ status: response.status, body: await json(response) }).toMatchObject({
			status: 400,
			body: { code: "ENTRY_INVALID", data: { problems: [{ at: "fields.category" }] } },
		});
		expect((await draftOf(entryId)).draft.fields.minutes).toBe(6);
	});

	test("a Body is the block editor's: refused here", async () => {
		const response = await area.edit("details/save", {
			item: `entry:${entryId}`,
			fields: { body: [{ type: "paragraph", text: "Hi" }] },
		});

		expect({ status: response.status, code: (await json(response)).code }).toEqual({
			status: 400,
			code: "EDIT_FIELD_INVALID",
		});
	});
});

describe("who changes them", () => {
	test("an Author changes them: they are Content", async () => {
		const authorArea = await openBuildingArea(install, author, siteId);

		const response = await authorArea.edit("details/save", { item: `entry:${entryId}`, fields: { minutes: 4 } });

		expect(response.status).toBe(200);
		expect((await draftOf(entryId)).draft.fields.minutes).toBe(4);
		await authorArea.edit("details/save", { item: `entry:${entryId}`, fields: { minutes: 6 } });
	});

	test("another Site's Entry is out of reach", async () => {
		const otherSite = (await install.createSite(workspaceId, { name: "Other", slug: "other" })).id;
		const { entry: other } = await staff.api.entries.create({
			siteId: otherSite,
			postTypeId: (await staff.api.postTypes.list({ siteId: otherSite })).postTypes[0]?.id ?? "",
			title: "Theirs",
		});

		const response = await area.edit("details/save", { item: `entry:${other.id}`, title: "Stolen" });

		expect(response.status).toBe(404);
		expect((await staff.api.entries.get({ siteId: otherSite, entryId: other.id })).entry.draft.title).toBe("Theirs");
	});
});
