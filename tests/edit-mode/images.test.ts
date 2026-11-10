// Images in Edit mode: an image a page shows from a media Field (an Entry's, the Globals', a Loop
// item's) or a Body's image Block is tagged on the page, and clicking it opens the image popover. A
// new image is chosen from the Site's Media library or uploaded (the library's own limits, checks and
// processing), alt text is written per language (with the AI's suggestion where the Workspace has an
// AI key) and the Focal point is set on the image. The image a page shows is Content and goes to the
// Draft like every change in Edit mode; alt text and the Focal point belong to the Media item itself,
// shared by every page that shows it, and change at once, as in the Media library.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { pdf, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

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

type Bakery = { siteId: string; origin: string; entryId: string; loaf: string; rolls: string };

/** A ready image in the Site's Media library, uploaded a second after the one before. */
async function readyImage(browser: TestBrowser, siteId: string, name: string, width = 800, height = 600) {
	await install.clock.advance(1000);
	const { media } = await browser.api.media.upload({ siteId, file: upload(await photo({ width, height }), name) });
	expect((await install.drainJobs()).failed).toEqual([]);
	return media.id;
}

/**
 * A Site whose Recipes show a photo from a media Field and the Globals' logo, with a published
 * Recipe at /recipes/sourdough showing the loaf.
 */
async function bakery(): Promise<Bakery> {
	const slug = `images-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	const loaf = await readyImage(editor, siteId, "loaf.jpg");
	const rolls = await readyImage(editor, siteId, "rolls.jpg");
	await staff.api.globals.setFields({ siteId, fields: [{ key: "logo", label: "Logo", type: "media" }] });
	await editor.api.globals.saveDraft({ siteId, fields: { logo: loaf } });
	await editor.api.globals.publish({ siteId });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "cover", label: "Cover", type: "media" },
		],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<article><h1>{{ title }}</h1><img src="{{ photo }}" title="Our bread"><img src="{{ cover }}"><img src="{{ site.logo }}"></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Sourdough",
		fields: { photo: loaf },
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, origin: `https://${slug}.live.test`, entryId: entry.id, loaf, rolls };
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

/** The opening tags of the elements a page tags with `field`. */
function tagged(html: string, field: string): string[] {
	return [...html.matchAll(/<(?:img|span)\b[^>]*>/g)]
		.map((match) => match[0])
		.filter((tag) => tag.includes(`data-wc-field="${field}"`));
}

describe("images on a page in Edit mode", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");
	});

	test("an image from a media Field is tagged as an image region, with the Media item it shows", async () => {
		const html = await (await editing.page("/recipes/sourdough")).text();

		const [photoTag] = tagged(html, "photo");
		expect(photoTag).toStartWith("<img ");
		expect(photoTag).toContain(`data-wc-item="entry:${site.entryId}"`);
		expect(photoTag).toContain('data-wc-type="media"');
		expect(photoTag).toContain('data-wc-label="Photo"');
		expect(photoTag).toContain(`data-wc-media="${site.loaf}"`);
		expect(photoTag).toMatch(/ data-wc-id="[^"]+"/);
		// The Template's own attributes stay on the image.
		expect(photoTag).toContain('title="Our bread"');
	});

	test("an empty media Field shows an empty image region to choose one in", async () => {
		const html = await (await editing.page("/recipes/sourdough")).text();

		expect(tagged(html, "cover")).toEqual([
			expect.stringMatching(/^<span [^>]*data-wc-type="media"[^>]*>$/) as unknown as string,
		]);
		expect(tagged(html, "cover")[0]).not.toContain("data-wc-media");
	});

	test("the Globals' images are tagged too", async () => {
		const html = await (await editing.page("/recipes/sourdough")).text();

		const [logo] = tagged(html, "logo");
		expect(logo).toContain('data-wc-item="globals"');
		expect(logo).toContain('data-wc-type="media"');
		expect(logo).toContain(`data-wc-media="${site.loaf}"`);
	});

	test("visitors' pages carry no tags", async () => {
		const html = await (await install.request(`${site.origin}/recipes/sourdough`)).text();

		expect(html).not.toContain("data-wc-");
		expect(html).toContain("<picture>");
	});
});

describe("choosing an image", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");
	});

	test("puts the image in the Draft; the page in Edit mode shows it, visitors still see the published one", async () => {
		const response = await editing.edit("image", {
			item: `entry:${site.entryId}`,
			field: "photo",
			media: site.rolls,
		});

		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({ status: "changed", media: site.rolls, problems: [] });
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.photo).toBe(site.rolls);
		expect(entry.published?.fields.photo).toBe(site.loaf);
		const [shown] = tagged(await (await editing.page("/recipes/sourdough")).text(), "photo");
		expect(shown).toContain(`data-wc-media="${site.rolls}"`);
		const visitors = await (await install.request(`${site.origin}/recipes/sourdough`)).text();
		const { media: loaf } = await editor.api.media.get({ siteId: site.siteId, mediaId: site.loaf });
		expect(visitors).toContain(`src="${loaf.url}"`);
	});

	test("fills an empty image region, and empties one with null", async () => {
		const filled = await editing.edit("image", { item: `entry:${site.entryId}`, field: "cover", media: site.loaf });
		expect(await json(filled)).toMatchObject({ media: site.loaf });
		expect(tagged(await (await editing.page("/recipes/sourdough")).text(), "cover")[0]).toStartWith("<img ");

		const emptied = await editing.edit("image", { item: `entry:${site.entryId}`, field: "cover", media: null });
		expect(await json(emptied)).toMatchObject({ media: null });
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.fields.cover).toBeNull();
		expect(tagged(await (await editing.page("/recipes/sourdough")).text(), "cover")[0]).toStartWith("<span ");
	});

	test("changes the Globals' image the same way", async () => {
		const response = await editing.edit("image", { item: "globals", field: "logo", media: site.rolls });

		expect(await json(response)).toMatchObject({ media: site.rolls });
		const { globals } = await editor.api.globals.get({ siteId: site.siteId });
		expect(globals.draft.logo).toBe(site.rolls);
		expect(globals.published?.logo).toBe(site.loaf);
	});

	test("takes only images of the Site's own library, and only for an image region", async () => {
		const { media: leaflet } = await editor.api.media.upload({
			siteId: site.siteId,
			file: upload(await pdf(), "menu.pdf"),
		});
		const other = await bakery();
		const item = `entry:${site.entryId}`;

		const document = await editing.edit("image", { item, field: "photo", media: leaflet.id });
		expect({ status: document.status, code: (await json(document)).code }).toEqual({
			status: 400,
			code: "MEDIA_INVALID",
		});
		const elsewhere = await editing.edit("image", { item, field: "photo", media: other.rolls });
		expect({ status: elsewhere.status, code: (await json(elsewhere)).code }).toEqual({
			status: 404,
			code: "MEDIA_NOT_FOUND",
		});
		const title = await editing.edit("image", { item, field: "title", media: site.rolls });
		expect({ status: title.status, code: (await json(title)).code }).toEqual({
			status: 400,
			code: "EDIT_FIELD_INVALID",
		});
		const otherEntry = await editing.edit("image", {
			item: `entry:${other.entryId}`,
			field: "photo",
			media: other.rolls,
		});
		expect(otherEntry.status).toBe(404);
		const { entry } = await editor.api.entries.get({ siteId: other.siteId, entryId: other.entryId });
		expect(entry.draft.fields.photo).toBe(other.loaf);
	});

	test("an image in the Trash can't be chosen", async () => {
		const binned = await readyImage(editor, site.siteId, "old.jpg");
		const asked = await editor.api.media.delete({ siteId: site.siteId, mediaId: binned });
		if (!("confirmation" in asked)) throw new Error("Expected a confirmation.");
		await editor.api.media.delete({ siteId: site.siteId, mediaId: binned, confirmation: asked.confirmation.id });

		const response = await editing.edit("image", { item: `entry:${site.entryId}`, field: "photo", media: binned });

		expect({ status: response.status, code: (await json(response)).code }).toEqual({
			status: 409,
			code: "MEDIA_IN_TRASH",
		});
	});
});

type LibraryItem = {
	id: string;
	fileName: string;
	alt: string | null;
	url: string | null;
	thumbnail: string | null;
	status: string;
	canEdit: boolean;
};

describe("the Media library in Edit mode", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");
	});

	test("lists the Site's images, newest first, with a small file to show each and its alt text", async () => {
		await editor.api.media.update({ siteId: site.siteId, mediaId: site.rolls, alt: "Six rolls on a tray" });
		await editor.api.media.upload({ siteId: site.siteId, file: upload(await pdf(), "allergens.pdf") });

		const response = await editing.edit("media/list", {});

		expect(response.status).toBe(200);
		const listed = (await json(response)) as { items: LibraryItem[]; total: number };
		expect(listed.items.map((item) => item.fileName)).toEqual(["rolls.jpg", "loaf.jpg"]);
		expect(listed.total).toBe(2);
		const [rolls] = listed.items;
		expect(rolls).toMatchObject({ id: site.rolls, alt: "Six rolls on a tray", status: "ready", canEdit: true });
		expect(rolls?.url).toStartWith("/_media/");
		expect(rolls?.thumbnail).toMatch(/^\/_media\/[0-9a-f]{16}-rolls-320\.webp$/);
	});

	test("searches by name, title and alt text, and opens folders", async () => {
		const { folder } = await editor.api.media.folders.create({ siteId: site.siteId, name: "Breads" });
		await editor.api.media.update({ siteId: site.siteId, mediaId: site.loaf, folderId: folder.id });

		const searched = (await json(await editing.edit("media/list", { search: "tray" }))) as { items: LibraryItem[] };
		expect(searched.items.map((item) => item.id)).toEqual([site.rolls]);
		const inFolder = (await json(await editing.edit("media/list", { folderId: folder.id }))) as {
			items: LibraryItem[];
			folders: { id: string; name: string; count: number }[];
		};
		expect(inFolder.items.map((item) => item.id)).toEqual([site.loaf]);
		expect(inFolder.folders).toEqual([{ id: folder.id, name: "Breads", count: 1 }]);
	});

	test("never lists another Site's images", async () => {
		const other = await bakery();

		const listed = (await json(await editing.edit("media/list", {}))) as { items: LibraryItem[] };

		expect(listed.items.map((item) => item.id)).not.toContain(other.loaf);
		const elsewhere = await editing.edit("media/get", { media: other.loaf });
		expect(elsewhere.status).toBe(404);
	});
});

describe("alt text and the Focal point", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		await staff.api.languages.add({ siteId: site.siteId, code: "it" });
		editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");
	});

	test("one image, as the popover shows it: its alt text in a language, its size and Focal point", async () => {
		await editor.api.media.update({ siteId: site.siteId, mediaId: site.loaf, alt: "A round loaf" });

		const response = await editing.edit("media/get", { media: site.loaf, language: "en" });

		expect(response.status).toBe(200);
		expect(await json(response)).toMatchObject({
			media: { id: site.loaf, alt: "A round loaf", width: 800, height: 600, focalPoint: null, canEdit: true },
			altTextSuggestions: false,
		});
	});

	test("alt text is saved per language, on the Media item: published pages show it at once", async () => {
		const english = await editing.edit("media/update", { media: site.loaf, language: "en", alt: "Sourdough loaf" });
		const italian = await editing.edit("media/update", { media: site.loaf, language: "it", alt: "Pagnotta" });

		expect(english.status).toBe(200);
		expect(await json(italian)).toMatchObject({ media: { alt: "Pagnotta" } });
		const { media } = await editor.api.media.get({ siteId: site.siteId, mediaId: site.loaf, language: "it" });
		expect(media.alt).toBe("Pagnotta");
		const visitors = await (await install.request(`${site.origin}/recipes/sourdough`)).text();
		expect(visitors).toContain('alt="Sourdough loaf"');
		const inItalian = await (await install.request(`${site.origin}/it/recipes/sourdough`)).text();
		expect(inItalian).toContain('alt="Pagnotta"');
	});

	test("the Focal point is set once for the image, in every language; null clears it", async () => {
		const set = await editing.edit("media/update", { media: site.loaf, focalPoint: { x: 30, y: 70 } });

		expect(await json(set)).toMatchObject({ media: { focalPoint: { x: 30, y: 70 } } });
		const visitors = await (await install.request(`${site.origin}/recipes/sourdough`)).text();
		expect(visitors).toContain("wc-focus wc-fx-30 wc-fy-70");
		const cleared = await editing.edit("media/update", { media: site.loaf, focalPoint: null });
		expect(await json(cleared)).toMatchObject({ media: { focalPoint: null } });
		const outside = await editing.edit("media/update", { media: site.loaf, focalPoint: { x: 120, y: 5 } });
		expect(outside.status).toBe(400);
	});

	test("Authors change the alt text and Focal point of their own uploads only", async () => {
		const authoring = await openEditMode(install, author, site.siteId, "/recipes/sourdough");
		const own = await readyImage(author, site.siteId, "crust.jpg");

		const theirs = await authoring.edit("media/update", { media: own, alt: "The crust" });
		expect(theirs.status).toBe(200);
		const editors = await authoring.edit("media/update", { media: site.loaf, alt: "Not mine" });
		expect({ status: editors.status, code: (await json(editors)).code }).toEqual({ status: 403, code: "FORBIDDEN" });
		const listed = (await json(await authoring.edit("media/list", {}))) as { items: LibraryItem[] };
		expect(listed.items.find((item) => item.id === site.loaf)?.canEdit).toBe(false);
		expect(listed.items.find((item) => item.id === own)?.canEdit).toBe(true);
	});

	test("suggests alt text in a language where the Workspace has an AI key; nothing is saved", async () => {
		const without = await editing.edit("media/suggestAlt", { media: site.rolls, language: "it" });
		expect({ status: without.status, code: (await json(without)).code }).toEqual({
			status: 409,
			code: "AI_KEY_MISSING",
		});

		await staff.api.aiKeys.setOwn({
			workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: "sk-test-workspace-key-0123456789",
		});
		install.ai.answer(({ language }) => ({ text: language === "it" ? "Sei panini" : "Six rolls" }));

		expect(await json(await editing.edit("media/get", { media: site.rolls }))).toMatchObject({
			altTextSuggestions: true,
		});
		const suggested = await editing.edit("media/suggestAlt", { media: site.rolls, language: "it" });
		expect(await json(suggested)).toEqual({ alt: "Sei panini" });
		const { media } = await editor.api.media.get({ siteId: site.siteId, mediaId: site.rolls, language: "it" });
		expect(media.alt).toBeNull();
	});
});

/** Uploads a file from a page in Edit mode, as the image popover does: a multipart body with the header token. */
async function uploadInEditMode(
	editing: EditModeBrowser,
	file: File,
	options: { folderId?: string; headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
	const form = new FormData();
	form.set("file", file);
	if (options.folderId) form.set("folderId", options.folderId);
	return editing.browser.request(`${editing.origin}/_webcraft/edit/api/media/upload`, {
		method: "POST",
		headers: { "x-webcraft-edit-token": await editing.headerToken(), ...options.headers },
		body: options.body ?? form,
	});
}

describe("uploading in Edit mode", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");
	});

	test("takes an image into the library as the Media screen does: cleaned by the worker before it shows", async () => {
		const { folder } = await editor.api.media.folders.create({ siteId: site.siteId, name: "Cakes" });

		const response = await uploadInEditMode(editing, upload(await photo({ width: 900, height: 600 }), "cake.jpg"), {
			folderId: folder.id,
		});

		expect(response.status).toBe(200);
		const { media } = (await json(response)) as { media: LibraryItem };
		expect(media).toMatchObject({ fileName: "cake.jpg", status: "processing", url: null });
		expect((await install.drainJobs()).failed).toEqual([]);
		expect(await json(await editing.edit("media/get", { media: media.id }))).toMatchObject({
			media: { status: "ready", width: 900, height: 600 },
		});
		const { media: stored } = await editor.api.media.get({ siteId: site.siteId, mediaId: media.id });
		expect(stored.folderId).toBe(folder.id);
		expect(stored.uploadedBy?.id).toBeDefined();
	});

	test("refuses what the library refuses: a file of no type it takes, a file over the largest", async () => {
		const unknown = await uploadInEditMode(editing, upload("just some words", "notes.jpg"));
		expect({ status: unknown.status, code: (await json(unknown)).code }).toEqual({
			status: 400,
			code: "MEDIA_TYPE_REFUSED",
		});

		const { api: admin } = await install.superadmin();
		await admin.install.media.update({ maxFileBytes: 1024 * 1024 });
		try {
			const big = new Uint8Array(1024 * 1024 + 70 * 1024);
			big.set(await photo({ width: 10, height: 10 }));
			const tooLarge = await uploadInEditMode(editing, upload(big, "huge.jpg"));
			expect({ status: tooLarge.status, body: await json(tooLarge) }).toMatchObject({
				status: 413,
				body: { code: "MEDIA_TOO_LARGE", data: { maxBytes: 1024 * 1024 } },
			});
		} finally {
			await admin.install.media.update({ maxFileBytes: 50 * 1024 * 1024 });
		}
	});

	test("a body that says it is larger than the largest file is refused before it is read", async () => {
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 64 * 1024;
				controller.enqueue(new Uint8Array(64 * 1024));
			},
		});

		const response = await uploadInEditMode(editing, upload("", "x.jpg"), {
			headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(400 * 1024 * 1024) },
			body,
		});

		expect(response.status).toBe(413);
		expect(pulled).toBeLessThanOrEqual(2 * 1024 * 1024);
	});

	test("an upload needs the header token and the Site's own page, as every edit request does", async () => {
		const file = upload(await photo({ width: 20, height: 20 }), "sneaky.jpg");

		const noToken = await uploadInEditMode(editing, file, { headers: { "x-webcraft-edit-token": "" } });
		expect(noToken.status).toBe(403);
		// Another site's page, sending the edit cookie along with the token it can't read anyway.
		const form = new FormData();
		form.set("file", file);
		const elsewhere = await install.request(
			new Request(`${editing.origin}/_webcraft/edit/api/media/upload`, {
				method: "POST",
				headers: {
					cookie: Array.from(editing.browser.cookies, ([name, value]) => `${name}=${value}`).join("; "),
					origin: "https://elsewhere.test",
					"sec-fetch-site": "cross-site",
					"x-webcraft-edit-token": await editing.headerToken(),
				},
				body: form,
			}),
		);
		expect(elsewhere.status).toBe(403);
		const listed = (await json(await editing.edit("media/list", { search: "sneaky" }))) as { items: LibraryItem[] };
		expect(listed.items).toEqual([]);
	});
});

describe("a body's image Blocks", () => {
	let site: Bakery;
	let editing: EditModeBrowser;
	let postId: string;

	beforeAll(async () => {
		site = await bakery();
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Posts",
			urlPattern: "/posts/{slug}",
			fields: [{ key: "body", label: "Story", type: "body" }],
		});
		const template = await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: postType.id,
			markup: "<article><h1>{{ title }}</h1><div>{{ body }}</div></article>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: template.template.id });
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: postType.id,
			title: "Our week",
			fields: {
				body: [
					{ id: "intro", type: "paragraph", text: "A week at the bakery." },
					{ id: "photo", type: "image", media: site.loaf },
					{ id: "later", type: "image", media: null },
				],
			},
		});
		postId = entry.id;
		await editor.api.entries.publish({ siteId: site.siteId, entryId: postId });
		editing = await openEditMode(install, editor, site.siteId, "/posts/our-week");
	});

	test("an image Block's image is an image region, named by its Block; one with no image yet too", async () => {
		const html = await (await editing.page("/posts/our-week")).text();

		const [photoBlock, emptyBlock] = tagged(html, "body");
		expect(photoBlock).toStartWith("<img ");
		expect(photoBlock).toContain(`data-wc-item="entry:${postId}"`);
		expect(photoBlock).toContain('data-wc-block="photo"');
		expect(photoBlock).toContain('data-wc-type="media"');
		expect(photoBlock).toContain('data-wc-label="Story"');
		expect(photoBlock).toContain(`data-wc-media="${site.loaf}"`);
		expect(emptyBlock).toStartWith("<span ");
		expect(emptyBlock).toContain('data-wc-block="later"');
		// The paragraph isn't a region: the body's text is the block editor's (#79).
		expect(html).toContain("<p>A week at the bakery.</p>");
	});

	test("choosing an image changes that Block only, in the Draft", async () => {
		const response = await editing.edit("image", {
			item: `entry:${postId}`,
			field: "body",
			block: "photo",
			media: site.rolls,
		});

		expect(await json(response)).toMatchObject({ status: "changed", media: site.rolls });
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: postId });
		expect(entry.draft.fields.body).toEqual([
			{ id: "intro", type: "paragraph", text: [{ text: "A week at the bakery." }] },
			{ id: "photo", type: "image", media: site.rolls },
			{ id: "later", type: "image", media: null },
		]);
		expect(((entry.published?.fields.body ?? []) as { media?: string }[])[1]?.media).toBe(site.loaf);
	});

	test("refuses a Block that isn't one of the body's image Blocks", async () => {
		for (const block of ["intro", "nowhere"]) {
			const response = await editing.edit("image", {
				item: `entry:${postId}`,
				field: "body",
				block,
				media: site.rolls,
			});
			expect({ block, status: response.status, code: (await json(response)).code }).toEqual({
				block,
				status: 400,
				code: "EDIT_FIELD_INVALID",
			});
		}
	});
});
