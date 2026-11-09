// The Body field (ADR 0018): long-form text kept as a list of typed Blocks with stable ids, never as
// HTML. A Post Type has at most one, Pages never have one, and Staff can switch Blocks off. Values
// are checked on save like every other Field's: the wrong kind is refused, broken rules are kept in
// the Draft and listed in `problems`, and publishing refuses them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let author: TestBrowser;
let editor: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

type FieldInputs = Parameters<TestBrowser["api"]["postTypes"]["create"]>[0]["fields"];

let postTypes = 0;

/** A Post Type with the given Fields, at its own URL pattern. */
async function postTypeWith(fields: FieldInputs) {
	const key = `kind-${++postTypes}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Kind ${postTypes}`,
		key,
		urlPattern: `/${key}/{slug}`,
		fields,
	});
	return postType;
}

/** A Post Type with a Body field (`body`), and an Entry of it whose Draft holds `body`. */
async function entryWithBody(body: unknown, settings: Record<string, unknown> = {}) {
	const postType = await postTypeWith([{ key: "body", label: "Body", type: "body", ...settings }]);
	const { entry } = await author.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Spring menu",
		fields: { body },
	});
	return { postType, entry };
}

describe("defining a Body field", () => {
	test("is translatable by default, has no default, and every Block is on until Staff switch some off", async () => {
		const postType = await postTypeWith([
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "body", label: "Body", type: "body", help: "The article.", required: true },
		]);

		expect(postType.fields[1]).toEqual({
			key: "body",
			label: "Body",
			type: "body",
			help: "The article.",
			required: true,
			translatable: true,
			default: null,
			blocksOff: [],
		});

		const { postType: changed } = await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			fields: [
				{ key: "summary", label: "Summary", type: "text" },
				{ key: "body", label: "Body", type: "body", blocksOff: ["video", "table", "video"] },
			],
		});
		// Each once, in the order the block editor offers them.
		expect(changed.fields[1]).toMatchObject({ blocksOff: ["video", "table"] });
	});

	test("a Post Type has at most one, at the top of its Fields", async () => {
		const refusals: [FieldInputs, string][] = [
			[
				[
					{ key: "body", label: "Body", type: "body" },
					{ key: "more", label: "More", type: "body" },
				],
				"fields[1].type",
			],
			[
				[{ key: "story", label: "Story", type: "group", fields: [{ key: "body", label: "Body", type: "body" }] }],
				"fields[0].fields[0].type",
			],
			[
				[{ key: "steps", label: "Steps", type: "repeater", fields: [{ key: "body", label: "Body", type: "body" }] }],
				"fields[0].fields[0].type",
			],
			[[{ key: "body", label: "Body", type: "body", blocksOff: ["paragraph"] }], "fields[0].blocksOff[0]"],
			[[{ key: "body", label: "Body", type: "body", blocksOff: ["gallery"] }], "fields[0].blocksOff[0]"],
			[[{ key: "body", label: "Body", type: "body", default: [] }], "fields[0].default"],
		];
		for (const [fields, at] of refusals) {
			await expect(
				staff.api.postTypes.create({
					siteId,
					name: "Articles",
					key: "articles",
					urlPattern: "/articles/{slug}",
					fields,
				}),
				`${JSON.stringify(fields)} is refused at ${at}`,
			).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at }] } });
		}
	});

	test("Pages, the Globals and Components' Props never have one", async () => {
		const { postTypes: all } = await staff.api.postTypes.list({ siteId });
		const pages = all.find((each) => each.builtIn === "page");
		await expect(
			staff.api.postTypes.update({
				siteId,
				postTypeId: pages?.id ?? "",
				fields: [{ key: "body", label: "Body", type: "body" }],
			}),
		).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at: "fields[0].type" }] } });

		await expect(
			staff.api.globals.setFields({ siteId, fields: [{ key: "body", label: "Body", type: "body" }] }),
		).rejects.toMatchObject({ code: "GLOBALS_INVALID", data: { problems: [{ at: "fields[0].type" }] } });

		await expect(
			staff.api.components.create({ siteId, name: "Story", props: [{ key: "body", label: "Body", type: "body" }] }),
		).rejects.toMatchObject({ data: { problems: [{ at: "props[0].type" }] } });
	});
});

describe("Blocks in a Draft", () => {
	test("every Block type is kept in its canonical form, with stable ids", async () => {
		const { entry } = await entryWithBody([
			{ id: "intro", type: "paragraph", text: "Fresh from the oven." },
			{ type: "heading", level: 2, text: [{ text: "How we\nbake" }] },
			{
				type: "paragraph",
				text: [
					{ text: "Bake at " },
					{ text: "220", marks: ["italic", "bold", "bold"] },
					{ text: " °C", marks: ["bold", "italic"] },
					{ text: "" },
					{ text: " for " },
					{ text: "40 minutes", link: "/guides/timing" },
				],
			},
			{
				type: "list",
				style: "numbered",
				items: ["Feed the starter", { text: "Mix", items: [{ text: "Flour" }, "Water"] }],
			},
			{ type: "quote", text: "Bread is life." },
			{ type: "image", media: null },
			{ type: "video", url: " https://youtu.be/dQw4w9WgXcQ ", title: "Shaping a loaf " },
			{ type: "table", rows: [["Loaf", "Price"], ["Sourdough"]] },
			{ type: "callout", tone: "warning", text: "Hot surfaces." },
			{ type: "code", code: "bake(loaf)\r\n", language: "JS" },
			{ type: "divider" },
			{ type: "toggle", summary: "Allergens", text: "Gluten." },
			{ id: "later", type: "heading", level: 3, text: "Notes", anchor: "notes-2027" },
		]);

		const blocks = entry.draft.fields.body as Record<string, unknown>[];
		const ids = blocks.map((block) => block.id);
		expect(ids[0]).toBe("intro");
		expect(ids.at(-1)).toBe("later");
		for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		expect(new Set(ids).size).toBe(ids.length);
		expect(blocks.map(({ id: _, ...block }) => block)).toEqual([
			{ type: "paragraph", text: [{ text: "Fresh from the oven." }] },
			{ type: "heading", level: 2, text: [{ text: "How we bake" }] },
			{
				type: "paragraph",
				text: [
					{ text: "Bake at " },
					{ text: "220 °C", marks: ["bold", "italic"] },
					{ text: " for " },
					{ text: "40 minutes", link: "/guides/timing" },
				],
			},
			{
				type: "list",
				style: "numbered",
				items: [
					{ text: [{ text: "Feed the starter" }] },
					{ text: [{ text: "Mix" }], items: [{ text: [{ text: "Flour" }] }, { text: [{ text: "Water" }] }] },
				],
			},
			{ type: "quote", text: [{ text: "Bread is life." }] },
			{ type: "image", media: null },
			{ type: "video", url: "https://youtu.be/dQw4w9WgXcQ", title: "Shaping a loaf" },
			{
				type: "table",
				headerRow: true,
				rows: [
					[[{ text: "Loaf" }], [{ text: "Price" }]],
					[[{ text: "Sourdough" }], []],
				],
			},
			{ type: "callout", tone: "warning", text: [{ text: "Hot surfaces." }] },
			{ type: "code", code: "bake(loaf)\n", language: "js" },
			{ type: "divider" },
			{ type: "toggle", summary: [{ text: "Allergens" }], text: [{ text: "Gluten." }] },
			{ type: "heading", level: 3, text: [{ text: "Notes" }], anchor: "notes-2027" },
		]);
		expect(entry.problems).toEqual([]);

		// The same Blocks saved again keep their ids; a Block given without one is new.
		const { entry: saved } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: { body: [...blocks.slice(0, 2), { type: "paragraph", text: "Added." }] },
		});
		const again = saved.draft.fields.body as Record<string, unknown>[];
		expect(again.slice(0, 2)).toEqual(blocks.slice(0, 2));
		expect(again[2]).toMatchObject({ type: "paragraph", text: [{ text: "Added." }] });
		expect(ids).not.toContain(again[2]?.id);

		const { entry: cleared } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: { body: null },
		});
		expect(cleared.draft.fields.body).toEqual([]);
	});

	test("Blocks of the wrong kind are refused, each at its place", async () => {
		const { entry } = await entryWithBody([{ id: "a", type: "paragraph", text: "Kept." }]);
		const refusals: [unknown, string][] = [
			["Just text", "fields.body"],
			[[{ type: "gallery" }], "fields.body[0].type"],
			[[{ type: "paragraph", text: [{ text: "Hi", link: "javascript:alert(1)" }] }], "fields.body[0].text[0].link"],
			[[{ type: "paragraph", text: [{ text: "Hi", marks: ["underline"] }] }], "fields.body[0].text[0].marks"],
			[[{ type: "paragraph", text: "Hi", colour: "red" }], "fields.body[0].colour"],
			[[{ type: "heading", level: 1, text: "Title" }], "fields.body[0].level"],
			[[{ type: "heading", level: 2, text: "Top", anchor: "wc-main" }], "fields.body[0].anchor"],
			[[{ type: "callout", tone: "pink", text: "Hi" }], "fields.body[0].tone"],
			[[{ type: "image", media: "sourdough.jpg" }], "fields.body[0].media"],
			[[{ type: "table", rows: "a,b" }], "fields.body[0].rows"],
			[
				[{ type: "list", items: [{ text: "1", items: [{ text: "2", items: [{ text: "3", items: ["4"] }] }] }] }],
				"fields.body[0].items[0].items[0].items[0].items",
			],
			[
				[
					{ id: "same", type: "paragraph", text: "One" },
					{ id: "same", type: "paragraph", text: "Two" },
				],
				"fields.body[1].id",
			],
			[[{ type: "paragraph", text: "x".repeat(20_001) }], "fields.body[0].text"],
		];
		for (const [body, at] of refusals) {
			await expect(
				author.api.entries.saveDraft({ siteId, entryId: entry.id, fields: { body } }),
				`${JSON.stringify(body).slice(0, 120)} is refused at ${at}`,
			).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at }] } });
		}
		expect((await author.api.entries.get({ siteId, entryId: entry.id })).entry.draft.fields.body).toEqual([
			{ id: "a", type: "paragraph", text: [{ text: "Kept." }] },
		]);
	});

	test("Blocks that break a rule are kept in the Draft, listed, and keep it from being published", async () => {
		const { entry } = await entryWithBody(
			[
				{ type: "paragraph", text: "Our new ovens." },
				{ type: "table", rows: [["Oven", "Heat"]] },
				{ type: "video", url: "https://videos.example/ovens" },
				{ type: "image", media: "0d6f3a2e-6f50-4f86-9a5d-4c7a8f1b2e3d" },
			],
			{ blocksOff: ["table"] },
		);

		expect(entry.problems).toEqual([
			{ at: "fields.body[1]", rule: "blockType", message: expect.any(String) },
			{ at: "fields.body[2].url", rule: "video", message: expect.any(String) },
			{ at: "fields.body[3].media", rule: "media", message: expect.any(String) },
		]);
		await expect(editor.api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
			data: { problems: entry.problems },
		});

		const { media } = await author.api.media.upload({
			siteId,
			file: upload(await photo({ width: 400, height: 300 }), "ovens.jpg"),
		});
		const blocks = entry.draft.fields.body as Record<string, unknown>[];
		const { entry: fixed } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: {
				body: [blocks[0], { ...blocks[2], url: "https://vimeo.com/76979871" }, { ...blocks[3], media: media.id }],
			},
		});
		expect(fixed.problems).toEqual([]);
		await editor.api.entries.publish({ siteId, entryId: entry.id });
	});

	test("a required body needs a Block with something in it", async () => {
		const { entry } = await entryWithBody([{ type: "paragraph", text: "  " }, { type: "divider" }], { required: true });

		expect(entry.problems).toEqual([{ at: "fields.body", rule: "required", message: expect.any(String) }]);
		await expect(editor.api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INCOMPLETE",
			data: { missing: ["body"] },
		});
	});
});
