// The block editor in Edit mode (#79): a page's body is one region the editing bar edits Block by
// Block. The page tags it and marks each Block; `body/get` gives the editor the Blocks and what may be
// added (Blocks not switched off, the Components the Field allows); changes save to the Draft through
// the page's shared Draft (Co-editing) or `save`, with the admin's checks; `body/paste` converts what
// is pasted, and pasted image files go to the Media library through `media/upload`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openDraftInEditMode } from "../harness/co-editing.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let author: TestBrowser;
let siteId: string;
let postTypeId: string;
let noteId: string;

type Body = Record<string, unknown>[];

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	const { component } = await staff.api.components.create({
		siteId,
		name: "Note",
		props: [{ key: "text", label: "Text", type: "text", required: true }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<aside>{{ props.text }}</aside>",
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	noteId = component.id;
	postTypeId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Articles",
			key: "articles",
			urlPattern: "/articles/{slug}",
			fields: [{ key: "body", label: "Story", type: "body", blocksOff: ["table"], components: [noteId] }],
		})
	).postType.id;
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<article><h1>{{ title }}</h1><div>{{ body }}</div></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
});

afterAll(async () => {
	await install.close();
});

let articles = 0;

/** A published Article with a body, and Edit mode open on its page as the author. */
async function article(body: unknown[]) {
	const slug = `article-${++articles}`;
	const { entry } = await author.api.entries.create({ siteId, postTypeId, title: "Spring", slug, fields: { body } });
	// Edit mode opens a page never published too: one with problems stays a Draft.
	if (entry.problems.length === 0) await staff.api.entries.publish({ siteId, entryId: entry.id });
	const path = `/articles/${slug}`;
	const edit = await openEditMode(install, author, siteId, path);
	return { entry, path, edit, item: `entry:${entry.id}`, blocks: entry.draft.fields.body as Body };
}

describe("a body on a page in Edit mode", () => {
	test("is one region, tagged for the block editor, with each Block marked; visitors' pages carry none of it", async () => {
		const { entry, path, edit, blocks } = await article([
			{ type: "paragraph", text: "Fresh bread" },
			{ type: "component", component: noteId, props: [{ name: "text", value: "Hot" }] },
		]);
		const html = await (await edit.page(path)).text();
		const [first, second] = blocks as [Body[number], Body[number]];
		expect(html).toContain(
			`<div data-wc-item="entry:${entry.id}" data-wc-field="body" data-wc-type="body" data-wc-label="Story" data-wc-id=`,
		);
		expect(html).toContain(
			`<!--wc-block ${first.id}--><p>Fresh bread</p><!--/wc-block--><!--wc-block ${second.id}--><aside>Hot</aside><!--/wc-block-->`,
		);

		const visitors = await (await install.request(`https://bakery.live.test${path}`)).text();
		expect(visitors).toContain("<div><p>Fresh bread</p><aside>Hot</aside></div>");
		expect(visitors).not.toContain("wc-block");
	});

	test("body/get gives the editor the Blocks, the Blocks and Components it may add, and the body's problems and Checks", async () => {
		const { edit, item, blocks } = await article([
			{ type: "heading", level: 3, text: "Skipped a level" },
			{ type: "component", component: noteId, props: [] },
		]);

		const response = await edit.edit("body/get", { item, field: "body" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			label: "Story",
			language: "en",
			blocks,
			blocksOff: ["table"],
			components: [{ id: noteId, name: "Note", props: [expect.objectContaining({ key: "text", type: "text" })] }],
			problems: [expect.objectContaining({ at: "fields.body[1].props.text", rule: "prop" })],
			checks: [expect.objectContaining({ at: "fields.body[0]", check: "skippedHeading" })],
		});

		const other = await edit.edit("body/get", { item, field: "title" });
		expect(other.status).toBe(400);
		expect((await other.json()).code).toBe("EDIT_FIELD_INVALID");
	});
});

describe("saving a body in Edit mode", () => {
	test("save takes the body's Blocks, with the admin's checks", async () => {
		const { entry, edit, item, blocks } = await article([{ type: "paragraph", text: "Old" }]);
		const [first] = blocks as [Body[number]];

		const saved = await edit.edit("save", {
			item,
			field: "body",
			value: [
				{ ...first, text: "New" },
				{ type: "component", component: noteId, props: [{ name: "text", value: "Note" }] },
			],
		});
		expect(saved.status).toBe(200);
		expect(await saved.json()).toEqual({
			status: "changed",
			value: [
				{ id: first.id, type: "paragraph", text: [{ text: "New" }] },
				{ id: expect.any(String), type: "component", component: noteId, props: [{ name: "text", value: "Note" }] },
			],
			problems: [],
		});
		const { entry: read } = await author.api.entries.get({ siteId, entryId: entry.id });
		expect((read.draft.fields.body as Body)[0]).toMatchObject({ text: [{ text: "New" }] });

		const refused = await edit.edit("save", { item, field: "body", value: [{ type: "gallery" }] });
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({
			code: "ENTRY_INVALID",
			data: { problems: [{ at: "fields.body[0].type" }] },
		});
	});

	test("two people change different Blocks of one body through the shared Draft, and both changes are kept", async () => {
		const { entry, edit, blocks } = await article([
			{ type: "paragraph", text: "First" },
			{ type: "paragraph", text: "Second" },
		]);
		const other = await openEditMode(install, staff, siteId, `/articles/article-${articles}`);
		const one = await openDraftInEditMode(edit, { kind: "entry", id: entry.id });
		const two = await openDraftInEditMode(other, { kind: "entry", id: entry.id });
		const setText = (index: number, text: string) => (draft: unknown) => {
			const copy = structuredClone(draft) as { values: { body: { en: Body } } };
			const block = copy.values.body.en[index] as { text: unknown };
			block.text = [{ text }];
			return copy as never;
		};
		one.change(setText(0, "First, changed here"));
		two.change(setText(1, "Second, changed there"));
		await one.saved();
		await two.saved();

		const { entry: read } = await author.api.entries.get({ siteId, entryId: entry.id });
		expect(read.draft.fields.body).toEqual([
			{ id: (blocks[0] as { id: string }).id, type: "paragraph", text: [{ text: "First, changed here" }] },
			{ id: (blocks[1] as { id: string }).id, type: "paragraph", text: [{ text: "Second, changed there" }] },
		]);
		one.close();
		two.close();
	});
});

describe("pasting into a body in Edit mode", () => {
	test("body/paste converts what is pasted as the admin does, with the Field's Blocks switched off as text", async () => {
		const { edit, item } = await article([{ type: "paragraph", text: "Hi" }]);
		const response = await edit.edit("body/paste", {
			item,
			field: "body",
			html: "<h1>Title</h1><table><tr><th>A</th></tr><tr><td>1</td></tr></table>",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			blocks: [
				{ id: expect.any(String), type: "heading", level: 2, text: [{ text: "Title" }] },
				{ id: expect.any(String), type: "paragraph", text: [{ text: "A\n1" }] },
			],
		});
	});

	test("a pasted image file goes to the Media library, then into an image Block of the body", async () => {
		const { entry, edit, item, blocks } = await article([{ type: "paragraph", text: "Hi" }]);
		const form = new FormData();
		form.set("file", upload(await photo({ width: 400, height: 300 }), "pasted.png"));
		const uploaded = await edit.browser.request(
			new Request(`${edit.origin}/_webcraft/edit/api/media/upload`, {
				method: "POST",
				headers: { "x-webcraft-edit-token": await edit.headerToken() },
				body: form,
			}),
		);
		expect(uploaded.status).toBe(200);
		const { media } = (await uploaded.json()) as { media: { id: string } };

		const saved = await edit.edit("save", {
			item,
			field: "body",
			value: [...blocks, { type: "image", media: media.id }],
		});
		expect(saved.status).toBe(200);
		const { entry: read } = await author.api.entries.get({ siteId, entryId: entry.id });
		expect((read.draft.fields.body as Body)[1]).toMatchObject({ type: "image", media: media.id });
		expect(read.problems).toEqual([]);
	});
});
