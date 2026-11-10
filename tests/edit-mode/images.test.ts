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

/** A ready image in the Site's Media library. */
async function readyImage(browser: TestBrowser, siteId: string, name: string, width = 800, height = 600) {
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
