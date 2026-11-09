// Replace file: a Media item gets a new file but keeps its id, its texts and every use. Pages show
// the new file once it is ready (an image after the worker cleaned it), and the file it replaced is
// still served for 30 days, for pages loaded before.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { imageInfo, pdf, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";

const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;
let siteId: string;
let editor: TestBrowser;
let author: TestBrowser;
let accounts: { editor: TestAccount; author: TestAccount };
let postTypeId: string;

const onSite = (path: string) => `https://bakery.sites.test${path}`;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const member = await install.createMember({ workspaceId, role: "editor" });
	const authorMember = await install.createMember({ workspaceId, role: "author" });
	editor = member.browser;
	author = authorMember.browser;
	accounts = { editor: member.account, author: authorMember.account };
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Posts",
		urlPattern: "/posts/{slug}",
		fields: [
			{ key: "hero", label: "Hero image", type: "media" },
			{ key: "menu", label: "Menu", type: "media" },
		],
	});
	postTypeId = postType.id;
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: '<article><img src="{{ hero }}"><a href="{{ menu }}">Menu</a></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
});

afterAll(async () => {
	await install.close();
});

async function readyImage(browser: TestBrowser, name: string, width = 400, height = 300) {
	const { media } = await browser.api.media.upload({ siteId, file: upload(await photo({ width, height }), name) });
	expect((await install.drainJobs()).failed).toEqual([]);
	return (await browser.api.media.get({ siteId, mediaId: media.id })).media;
}

async function page(path: string) {
	const response = await install.request(onSite(path));
	return { cache: response.headers.get("x-cache"), html: await response.text() };
}

describe("Replace file", () => {
	test("keeps the item, its texts and every use; pages switch once the new image is ready; the old file stays 30 days", async () => {
		const image = await readyImage(editor, "loaf.jpg");
		await editor.api.media.update({ siteId, mediaId: image.id, alt: "A loaf" });
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Loaf",
			fields: { hero: image.id },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		expect((await page("/posts/loaf")).html).toContain(image.url ?? "-");

		const { media: replacing } = await editor.api.media.replace({
			siteId,
			mediaId: image.id,
			file: upload(await photo({ width: 800, height: 600 }), "Better Loaf.jpg"),
		});
		// Until the worker has cleaned the new image, everyone still gets the old one.
		expect(replacing).toMatchObject({ id: image.id, status: "ready", replacing: true, url: image.url, width: 400 });
		expect((await page("/posts/loaf")).html).toContain(image.url ?? "-");

		expect((await install.drainJobs()).failed).toEqual([]);
		const replaced = (await editor.api.media.get({ siteId, mediaId: image.id })).media;
		expect(replaced).toMatchObject({
			id: image.id,
			status: "ready",
			replacing: false,
			fileName: "Better Loaf.jpg",
			width: 800,
			height: 600,
			alt: "A loaf",
			failure: null,
		});
		expect(replaced.url).toMatch(/^\/_media\/[0-9a-f]{16}-better-loaf\.jpg$/);
		expect(replaced.variants.map((variant) => variant.width)).toEqual([320, 320, 640, 640]);

		const after = await page("/posts/loaf");
		expect(after.cache).toBe("MISS");
		expect(after.html).toContain(replaced.url ?? "-");
		expect(after.html).not.toContain(image.url ?? "-");
		expect((await editor.api.media.usage({ siteId, mediaId: image.id })).usedIn).toMatchObject([
			{ kind: "entry", id: entry.id },
		]);

		// A page loaded before still finds the file it names, for 30 days.
		const old = await install.request(onSite(image.url ?? ""));
		expect(old.status).toBe(200);
		expect((await imageInfo(new Uint8Array(await old.arrayBuffer()))).width).toBe(400);
		for (const variant of image.variants) expect((await install.request(onSite(variant.url))).status).toBe(200);

		await install.clock.advance(31 * DAY);
		expect((await install.drainJobs()).failed).toEqual([]);
		expect((await install.request(onSite(image.url ?? ""))).status).toBe(404);
		expect((await install.request(onSite(replaced.url ?? ""))).status).toBe(200);
		// Sessions end after 7 days unused.
		editor = await install.signIn(accounts.editor);
		author = await install.signIn(accounts.author);

		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((line) => line.action === "media.replace")).toMatchObject({
			details: { mediaId: image.id, fileName: "Better Loaf.jpg" },
		});
	});

	test("a document is replaced at once", async () => {
		const { media } = await editor.api.media.upload({ siteId, file: upload(pdf("Spring menu"), "menu.pdf") });
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Menus",
			fields: { menu: media.id },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		expect((await page("/posts/menus")).html).toContain(media.url ?? "-");

		const { media: replaced } = await editor.api.media.replace({
			siteId,
			mediaId: media.id,
			file: upload(pdf("Summer menu"), "summer-menu.pdf"),
		});

		expect(replaced).toMatchObject({ id: media.id, fileName: "summer-menu.pdf", replacing: false });
		expect(replaced.url).toMatch(/-summer-menu\.pdf$/);
		expect((await page("/posts/menus")).html).toContain(replaced.url ?? "-");
		expect((await install.request(onSite(media.url ?? ""))).status).toBe(200);
	});

	test("a file is replaced by one of the same kind", async () => {
		const image = await readyImage(editor, "kind.jpg");
		await expect(
			editor.api.media.replace({ siteId, mediaId: image.id, file: upload(pdf(), "kind.pdf") }),
		).rejects.toMatchObject({ code: "MEDIA_REPLACE_REFUSED", data: { reason: "kind" } });
	});

	test("a new image the worker can't read leaves the item as it was, and says so", async () => {
		const image = await readyImage(editor, "keep.jpg");
		const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new TextEncoder().encode("not a JPEG")]);
		await editor.api.media.replace({ siteId, mediaId: image.id, file: upload(broken, "broken.jpg") });
		await install.drainJobs();

		const after = (await editor.api.media.get({ siteId, mediaId: image.id })).media;
		expect(after).toMatchObject({
			status: "ready",
			replacing: false,
			url: image.url,
			width: 400,
			failure: { reason: "unreadable", replacement: true },
		});
		expect((await install.request(onSite(image.url ?? ""))).status).toBe(200);
	});

	test("Authors replace only their own uploads; a file in the Trash isn't replaced", async () => {
		const editors = await readyImage(editor, "editors-file.jpg");
		await expect(
			author.api.media.replace({
				siteId,
				mediaId: editors.id,
				file: upload(await photo({ width: 50, height: 50 }), "x.jpg"),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const asked = await editor.api.media.delete({ siteId, mediaId: editors.id });
		if (!asked.trashed)
			await editor.api.media.delete({ siteId, mediaId: editors.id, confirmation: asked.confirmation.id });
		await expect(
			editor.api.media.replace({
				siteId,
				mediaId: editors.id,
				file: upload(await photo({ width: 50, height: 50 }), "y.jpg"),
			}),
		).rejects.toMatchObject({ code: "MEDIA_IN_TRASH" });
	});
});
