// Used in: every place a Media item is used. Deleting a file warns where it is used (two steps) and
// puts it in a 30-day Trash, from which it can be restored; after 30 days it is deleted for good,
// and its stored bytes are removed once no other item shares them. Library changes go live at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { pdf, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let accounts: { editor: TestAccount; author: TestAccount };
let postTypeId: string;

type MediaView = Awaited<ReturnType<TestBrowser["api"]["media"]["get"]>>["media"];

const onSite = (path: string) => `https://bakery.live.test${path}`;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const editorMember = await install.createMember({ workspaceId, role: "editor" });
	const authorMember = await install.createMember({ workspaceId, role: "author" });
	editor = editorMember.browser;
	author = authorMember.browser;
	accounts = { editor: editorMember.account, author: authorMember.account };
	await staff.api.languages.add({ siteId, code: "it" });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Posts",
		urlPattern: "/posts/{slug}",
		fields: [
			{ key: "hero", label: "Hero image", type: "media" },
			{ key: "body", label: "Body", type: "body" },
		],
	});
	postTypeId = postType.id;
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: '<article><h1>{{ title }}</h1><img src="{{ hero }}"></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
});

afterAll(async () => {
	await install.close();
});

async function uploadImage(browser: TestBrowser, name: string): Promise<MediaView> {
	const { media } = await browser.api.media.upload({
		siteId,
		file: upload(await photo({ width: 400, height: 300 }), name),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	return (await browser.api.media.get({ siteId, mediaId: media.id })).media;
}

async function publishedPost(title: string, hero: string) {
	const { entry } = await editor.api.entries.create({ siteId, postTypeId, title, fields: { hero } });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return entry;
}

describe("Used in", () => {
	test("names every place a file is used: Entries in every language, the Globals, Templates, Components, Loops, the Design system", async () => {
		const image = await uploadImage(editor, "sourdough.jpg");
		const fresh = await publishedPost("Fresh bread", image.id);
		// Only the Italian body shows the image.
		const { entry: creme } = await editor.api.entries.create({ siteId, postTypeId, title: "Crème brûlée", fields: {} });
		await editor.api.entries.saveDraft({
			siteId,
			entryId: creme.id,
			language: "it",
			fields: {
				body: [
					{ type: "paragraph", text: "Ciao" },
					{ type: "image", media: image.id },
				],
			},
		});
		await staff.api.globals.setFields({ siteId, fields: [{ key: "logo", label: "Logo", type: "media" }] });
		await editor.api.globals.saveDraft({ siteId, fields: { logo: image.id } });
		const { component } = await staff.api.components.create({ siteId, name: "Badge" });
		await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: `<img src="media:${image.id}" alt="">`,
		});
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "gallery",
			source: "items",
			fields: [{ key: "photo", label: "Photo", type: "media" }],
		});
		await staff.api.loops.saveItems({ siteId, loopId: loop.id, items: [{ photo: image.id }] });
		await staff.api.designSystem.saveDraft({
			siteId,
			customCss: `body { background-image: url(${image.url}); }`,
		});

		const { usedIn } = await editor.api.media.usage({ siteId, mediaId: image.id });

		expect(usedIn).toEqual([
			{
				kind: "entry",
				id: creme.id,
				title: "Crème brûlée",
				postType: { id: postTypeId, name: "Posts" },
				versions: ["draft"],
				fields: ["body"],
			},
			{
				kind: "entry",
				id: fresh.id,
				title: "Fresh bread",
				postType: { id: postTypeId, name: "Posts" },
				versions: ["draft", "published"],
				fields: ["hero"],
			},
			{ kind: "globals", versions: ["draft"], fields: ["logo"] },
			{ kind: "component", id: component.id, name: "Badge", versions: ["draft"] },
			{ kind: "loop", id: loop.id, name: "gallery", versions: ["draft"] },
			{ kind: "designSystem", versions: ["draft"] },
		]);

		// A file nothing uses is used nowhere.
		const unused = await uploadImage(editor, "unused.jpg");
		expect((await editor.api.media.usage({ siteId, mediaId: unused.id })).usedIn).toEqual([]);
	});

	test("names the Templates that show a file", async () => {
		const image = await uploadImage(editor, "banner.jpg");
		const { template } = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: `<header><img src="media:${image.id}" alt=""></header><main>{{@outlet}}</main>`,
		});
		const { usedIn } = await editor.api.media.usage({ siteId, mediaId: image.id });
		expect(usedIn).toEqual([
			{ kind: "template", id: template.id, templateKind: "site", postType: null, versions: ["draft"] },
		]);
		await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	});
});

describe("deleting", () => {
	test("takes two steps, warns where the file is used, and puts it in the Trash; pages stop showing it at once", async () => {
		const image = await uploadImage(editor, "croissant.jpg");
		const post = await publishedPost("Croissants", image.id);
		const page = async () => install.request(onSite("/posts/croissants"));
		expect(await (await page()).text()).toContain(image.url ?? "-");
		expect((await page()).headers.get("x-cache")).toBe("HIT");

		const asked = await editor.api.media.delete({ siteId, mediaId: image.id });
		const confirmation = asked.trashed ? "" : asked.confirmation.id;
		expect(confirmation).toMatch(/^[0-9a-f-]{36}$/);
		expect(asked).toMatchObject({
			trashed: false,
			usedIn: [{ kind: "entry", id: post.id, title: "Croissants", versions: ["draft", "published"] }],
		});
		// Nothing changed yet.
		expect((await editor.api.media.get({ siteId, mediaId: image.id })).media.trashedAt).toBeNull();

		const done = await editor.api.media.delete({ siteId, mediaId: image.id, confirmation });
		expect(done).toMatchObject({ trashed: true });

		const after = await page();
		expect(after.headers.get("x-cache")).toBe("MISS");
		expect(await after.text()).not.toContain(image.url ?? "-");
		expect((await install.request(onSite(image.url ?? ""))).status).toBe(404);
		expect((await editor.api.media.list({ siteId })).items.map((item) => item.id)).not.toContain(image.id);

		const trash = await editor.api.media.list({ siteId, trash: true });
		const trashed = trash.items.find((item) => item.id === image.id);
		expect(trashed).toMatchObject({ id: image.id });
		expect(trashed?.trashedAt).toEqual(install.clock.now());
		expect(trashed?.purgeAt).toEqual(new Date(install.clock.now().getTime() + 30 * DAY));

		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((entry) => entry.action === "media.trash")).toMatchObject({
			details: { mediaId: image.id, fileName: "croissant.jpg" },
		});
	});

	test("a confirmation is for the file it was asked for, and asks again when its uses changed", async () => {
		const image = await uploadImage(editor, "eclair.jpg");
		const other = await uploadImage(editor, "macaron.jpg");
		const asked = await editor.api.media.delete({ siteId, mediaId: image.id });
		const confirmation = asked.trashed ? "" : asked.confirmation.id;
		await expect(editor.api.media.delete({ siteId, mediaId: other.id, confirmation })).rejects.toMatchObject({
			code: "CONFIRMATION_INVALID",
		});

		const again = await editor.api.media.delete({ siteId, mediaId: image.id });
		await publishedPost("Eclairs", image.id);
		await expect(
			editor.api.media.delete({ siteId, mediaId: image.id, confirmation: again.trashed ? "" : again.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "changed" } });
	});

	test("restoring puts the file back as it was, and pages show it again", async () => {
		const image = await uploadImage(editor, "bagel.jpg");
		await editor.api.media.update({ siteId, mediaId: image.id, alt: "A sesame bagel" });
		await publishedPost("Bagels", image.id);
		await trash(editor, image.id);
		expect(await (await install.request(onSite("/posts/bagels"))).text()).not.toContain(image.url ?? "-");

		const { media } = await editor.api.media.restore({ siteId, mediaId: image.id });

		expect(media).toMatchObject({ id: image.id, trashedAt: null, purgeAt: null, alt: "A sesame bagel" });
		expect(await (await install.request(onSite("/posts/bagels"))).text()).toContain(image.url ?? "-");
		expect((await install.request(onSite(image.url ?? ""))).status).toBe(200);
		await expect(editor.api.media.restore({ siteId, mediaId: image.id })).rejects.toMatchObject({
			code: "MEDIA_NOT_IN_TRASH",
		});
	});

	test("a file in the Trash can't be chosen for a media Field", async () => {
		const image = await uploadImage(editor, "scone.jpg");
		await trash(editor, image.id);
		await expect(
			editor.api.entries.create({ siteId, postTypeId, title: "Scones", fields: { hero: image.id } }),
		).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	});

	test("Authors put only their own uploads in the Trash and take only those out; Editors any", async () => {
		const own = await uploadImage(author, "author-own.jpg");
		const others = await uploadImage(editor, "editors.jpg");

		await trash(author, own.id);
		await expect(author.api.media.delete({ siteId, mediaId: others.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await trash(editor, others.id);
		await expect(author.api.media.restore({ siteId, mediaId: others.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect((await author.api.media.restore({ siteId, mediaId: own.id })).media.trashedAt).toBeNull();
	});
});

async function trash(browser: TestBrowser, mediaId: string) {
	const asked = await browser.api.media.delete({ siteId, mediaId });
	if (asked.trashed) return;
	await browser.api.media.delete({ siteId, mediaId, confirmation: asked.confirmation.id });
}

/** Moves the clock on, and signs the Members in again: their sessions end after 7 days unused. */
async function later(milliseconds: number) {
	await install.clock.advance(milliseconds);
	editor = await install.signIn(accounts.editor);
	author = await install.signIn(accounts.author);
}

describe("the Trash", () => {
	test("after 30 days a file is deleted for good; its stored bytes go once no other item shares them", async () => {
		const bytes = pdf("Opening hours");
		const { media: first } = await editor.api.media.upload({ siteId, file: upload(bytes, "hours.pdf") });
		const { media: second } = await editor.api.media.upload({ siteId, file: upload(bytes, "hours.pdf") });
		expect(second.url).toBe(first.url);
		const stored = join(install.storageDir, workspaceId, siteId, "media", (first.url ?? "").replace("/_media/", ""));

		await trash(editor, first.id);
		await later(29 * DAY);
		await install.drainJobs();
		expect((await editor.api.media.get({ siteId, mediaId: first.id })).media.trashedAt).not.toBeNull();

		await later(2 * DAY);
		expect((await install.drainJobs()).failed).toEqual([]);
		await expect(editor.api.media.get({ siteId, mediaId: first.id })).rejects.toMatchObject({
			code: "MEDIA_NOT_FOUND",
		});
		// The other item still holds the same bytes.
		expect(existsSync(stored)).toBe(true);
		expect((await install.request(onSite(second.url ?? ""))).status).toBe(200);

		await trash(editor, second.id);
		const before = (await editor.api.media.overview({ siteId })).storage.usedBytes;
		await later(31 * DAY);
		expect((await install.drainJobs()).failed).toEqual([]);
		expect(existsSync(stored)).toBe(false);
		expect((await editor.api.media.overview({ siteId })).storage.usedBytes).toBe(before - bytes.length);
	});

	test("deleting for good and emptying the Trash take two steps; emptying needs media.manage", async () => {
		const one = await uploadImage(editor, "one.jpg");
		const two = await uploadImage(author, "two.jpg");
		await expect(editor.api.media.deleteForever({ siteId, mediaId: one.id })).rejects.toMatchObject({
			code: "MEDIA_NOT_IN_TRASH",
		});
		await trash(editor, one.id);
		await trash(author, two.id);

		const asked = await author.api.media.deleteForever({ siteId, mediaId: two.id });
		expect(asked.deleted).toBe(false);
		await author.api.media.deleteForever({
			siteId,
			mediaId: two.id,
			confirmation: asked.deleted ? "" : asked.confirmation.id,
		});
		await expect(author.api.media.get({ siteId, mediaId: two.id })).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });

		await expect(author.api.media.emptyTrash({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		const inTrash = (await editor.api.media.list({ siteId, trash: true })).total;
		const empty = await editor.api.media.emptyTrash({ siteId });
		expect(empty).toMatchObject({ emptied: false, count: inTrash });
		expect(
			await editor.api.media.emptyTrash({ siteId, confirmation: empty.emptied ? "" : empty.confirmation.id }),
		).toEqual({ emptied: true, count: inTrash });
		expect((await editor.api.media.list({ siteId, trash: true })).total).toBe(0);
		await expect(editor.api.media.get({ siteId, mediaId: one.id })).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((entry) => entry.action === "mediaTrash.empty")).toMatchObject({
			details: { count: inTrash },
		});
	});
});
