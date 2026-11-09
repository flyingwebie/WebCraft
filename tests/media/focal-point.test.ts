// The Focal point: the spot of an image that must stay visible when a design shows it at another
// shape. Set once per image in the Media library (shared by every language), it positions the image
// on Site pages (`object-position`) through a fixed set of WebCraft's own classes in the Site's
// stylesheet, so pages keep their strict policy: no inline styles.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { pdf, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { layerOf, pageWithStyles } from "../harness/site-styles.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let siteId: string;
let editor: TestBrowser;
let author: TestBrowser;
let postTypeId: string;

const onSite = (path: string) => `https://gallery.live.test${path}`;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "gallery" })).id;
	await goLive(install, siteId);
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	await staff.api.languages.add({ siteId, code: "it" });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Photos",
		urlPattern: "/photos/{slug}",
		fields: [{ key: "photo", label: "Photo", type: "media" }],
	});
	postTypeId = postType.id;
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: '<article><img src="{{ photo }}" alt=""></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
});

afterAll(async () => {
	await install.close();
});

async function readyImage(browser: TestBrowser, name: string) {
	const { media } = await browser.api.media.upload({
		siteId,
		file: upload(await photo({ width: 400, height: 300 }), name),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	return media;
}

/** The <img> of a published page. */
async function imgOf(path: string) {
	const { html, css } = await pageWithStyles(install, onSite(path));
	return { img: /<img [^>]*>/.exec(html)?.[0] ?? "", css };
}

describe("the Focal point", () => {
	test("is set in the library, shared by every language, and positions the image on pages through classes", async () => {
		const image = await readyImage(editor, "harbour.jpg");
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Harbour",
			fields: { photo: image.id },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		expect((await imgOf("/photos/harbour")).img).not.toContain("wc-focus");

		const { media } = await editor.api.media.update({ siteId, mediaId: image.id, focalPoint: { x: 30, y: 70 } });
		expect(media.focalPoint).toEqual({ x: 30, y: 70 });
		expect((await editor.api.media.get({ siteId, mediaId: image.id, language: "it" })).media.focalPoint).toEqual({
			x: 30,
			y: 70,
		});

		// Live at once: the page cache is cleared, and the page names the classes; no inline style.
		const page = await install.request(onSite("/photos/harbour"));
		expect(page.headers.get("x-cache")).toBe("MISS");
		const { img, css } = await imgOf("/photos/harbour");
		expect(img).toContain('class="wc-focus wc-fx-30 wc-fy-70"');
		expect(img).not.toContain("style=");
		const base = layerOf(css, "base");
		expect(base).toContain(".wc-focus{object-position:var(--wc-fx,50%) var(--wc-fy,50%)}");
		expect(base).toContain(".wc-fx-30{--wc-fx:30%}");
		expect(base).toContain(".wc-fy-70{--wc-fy:70%}");

		// Pages place it to the nearest 5%.
		await editor.api.media.update({ siteId, mediaId: image.id, focalPoint: { x: 33, y: 67 } });
		expect((await imgOf("/photos/harbour")).img).toContain('class="wc-focus wc-fx-35 wc-fy-65"');
		// The Italian page shows the same spot.
		expect((await imgOf("/it/photos/harbour")).img).toContain('class="wc-focus wc-fx-35 wc-fy-65"');

		await editor.api.media.update({ siteId, mediaId: image.id, focalPoint: null });
		expect((await imgOf("/photos/harbour")).img).not.toContain("wc-focus");

		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((line) => line.action === "media.update")).toMatchObject({
			details: { mediaId: image.id, changed: ["focalPoint"] },
		});
	});

	test("only images have one; it is within the image; Authors set it on their own uploads only", async () => {
		const { media: document } = await editor.api.media.upload({ siteId, file: upload(pdf(), "guide.pdf") });
		await expect(
			editor.api.media.update({ siteId, mediaId: document.id, focalPoint: { x: 50, y: 50 } }),
		).rejects.toMatchObject({ code: "MEDIA_INVALID", data: { problems: [{ at: "focalPoint" }] } });

		const image = await readyImage(editor, "pier.jpg");
		await expect(
			editor.api.media.update({ siteId, mediaId: image.id, focalPoint: { x: 101, y: 50 } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			author.api.media.update({ siteId, mediaId: image.id, focalPoint: { x: 10, y: 10 } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const own = await readyImage(author, "author-photo.jpg");
		expect(
			(await author.api.media.update({ siteId, mediaId: own.id, focalPoint: { x: 0, y: 100 } })).media.focalPoint,
		).toEqual({ x: 0, y: 100 });
	});
});
