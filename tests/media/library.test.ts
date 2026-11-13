// The Media library screen's data: folders, search and filters, and each file's title, alt text and
// caption, stored per language (ADR 0003). Changes go live at once, with no Draft.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pdf, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let siteId: string;
let editor: TestBrowser;
let editorName: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId)).id;
	const member = await install.createMember({ workspaceId, role: "editor", name: "Giulia Romano" });
	editor = member.browser;
	editorName = member.account.name;
});

afterAll(async () => {
	await install.close();
});

async function uploadPdf(name: string, folderId?: string) {
	return (await editor.api.media.upload({ siteId, file: upload(pdf(name), name), folderId })).media;
}

describe("folders", () => {
	test("Editors make and rename folders; each lists how many files it holds", async () => {
		const { folder: products } = await editor.api.media.folders.create({ siteId, name: " Products " });
		const { folder: blog } = await editor.api.media.folders.create({ siteId, name: "Blog" });
		expect(products).toMatchObject({ name: "Products", count: 0 });

		await uploadPdf("price-list.pdf", products.id);
		await uploadPdf("catalogue.pdf", products.id);
		await uploadPdf("loose.pdf");
		await editor.api.media.folders.rename({ siteId, folderId: blog.id, name: "Journal" });

		const { folders, total } = await editor.api.media.folders.list({ siteId });
		expect(folders.map((folder) => [folder.name, folder.count])).toEqual([
			["Journal", 0],
			["Products", 2],
		]);
		expect(total).toBe(3);
	});

	test("two folders can't share a name, whatever its case", async () => {
		await editor.api.media.folders.create({ siteId, name: "Weddings" });
		await expect(editor.api.media.folders.create({ siteId, name: "weddings" })).rejects.toMatchObject({
			code: "MEDIA_FOLDER_TAKEN",
			status: 409,
		});
		await expect(editor.api.media.folders.create({ siteId, name: "   " })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	test("files move into a folder and out again; deleting a folder keeps its files in All media", async () => {
		const { folder } = await editor.api.media.folders.create({ siteId, name: "Team" });
		const file = await uploadPdf("rota.pdf");

		const moved = (await editor.api.media.update({ siteId, mediaId: file.id, folderId: folder.id })).media;
		expect(moved.folderId).toBe(folder.id);
		const inFolder = await editor.api.media.list({ siteId, folderId: folder.id });
		expect(inFolder.items.map((item) => item.fileName)).toEqual(["rota.pdf"]);

		await editor.api.media.folders.delete({ siteId, folderId: folder.id });
		const after = (await editor.api.media.get({ siteId, mediaId: file.id })).media;
		expect(after.folderId).toBeNull();
		expect((await editor.api.media.folders.list({ siteId })).folders.map((each) => each.name)).not.toContain("Team");
	});

	test("a folder of another Site, or none, is refused", async () => {
		const file = await uploadPdf("stray.pdf");
		await expect(
			editor.api.media.update({ siteId, mediaId: file.id, folderId: crypto.randomUUID() }),
		).rejects.toMatchObject({ code: "MEDIA_FOLDER_NOT_FOUND", status: 404 });
		await expect(
			editor.api.media.upload({ siteId, file: upload(pdf(), "x.pdf"), folderId: crypto.randomUUID() }),
		).rejects.toMatchObject({ code: "MEDIA_FOLDER_NOT_FOUND" });
	});
});

describe("the list", () => {
	test("newest first, with who uploaded each file and when", async () => {
		// The test clock stands still: files uploaded in the same instant could come in either order.
		await install.clock.advance(60_000);
		await uploadPdf("older.pdf");
		await install.clock.advance(60_000);
		await uploadPdf("newer.pdf");

		const { items } = await editor.api.media.list({ siteId });
		expect(items.slice(0, 2).map((item) => item.fileName)).toEqual(["newer.pdf", "older.pdf"]);
		expect(items[0]?.uploadedBy?.name).toBe(editorName);
		expect(items[0]?.createdAt).toEqual(install.clock.now());
	});

	test("search finds a file by its name, title or alt text, in any case", async () => {
		const loaf = (
			await editor.api.media.upload({ siteId, file: upload(await photo({ width: 40, height: 30 }), "IMG_2231.jpg") })
		).media;
		await editor.api.media.update({ siteId, mediaId: loaf.id, alt: "A round sourdough loaf on a floured board" });
		const menu = await uploadPdf("Spring Menu 2027.pdf");
		await editor.api.media.update({ siteId, mediaId: menu.id, title: "Seasonal specials" });

		const names = async (search: string) =>
			(await editor.api.media.list({ siteId, search })).items.map((item) => item.fileName);
		expect(await names("SOURDOUGH")).toEqual(["IMG_2231.jpg"]);
		expect(await names("spring menu")).toEqual(["Spring Menu 2027.pdf"]);
		expect(await names("specials")).toEqual(["Spring Menu 2027.pdf"]);
		expect(await names("100%_")).toEqual([]);
	});

	test("filters by kind: images, documents, video and audio", async () => {
		await editor.api.media.upload({ siteId, file: upload(await photo({ width: 40, height: 30 }), "kind-photo.jpg") });

		const images = await editor.api.media.list({ siteId, kind: "image" });
		const documents = await editor.api.media.list({ siteId, kind: "document" });
		expect(images.items.every((item) => item.kind === "image")).toBe(true);
		expect(images.items.map((item) => item.fileName)).toContain("kind-photo.jpg");
		expect(documents.items.every((item) => item.kind === "document")).toBe(true);
		expect(documents.total + images.total).toBe((await editor.api.media.list({ siteId })).total);
		expect((await editor.api.media.list({ siteId, kind: "video" })).items).toEqual([]);
	});

	test("files in no folder can be listed on their own", async () => {
		const { folder } = await editor.api.media.folders.create({ siteId, name: "Filed" });
		await uploadPdf("filed.pdf", folder.id);
		const unfiled = await editor.api.media.list({ siteId, folderId: "none" });
		expect(unfiled.items.map((item) => item.fileName)).not.toContain("filed.pdf");
		expect(unfiled.items.every((item) => item.folderId === null)).toBe(true);
	});

	test("pages of the list", async () => {
		const { total } = await editor.api.media.list({ siteId });
		const first = await editor.api.media.list({ siteId, limit: 2 });
		const second = await editor.api.media.list({ siteId, limit: 2, offset: 2 });
		expect(first.items).toHaveLength(2);
		expect(first.total).toBe(total);
		expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
	});
});

describe("title, alt text and caption", () => {
	test("are stored per language: written in the Site's Default language, cleared with null", async () => {
		const file = (
			await editor.api.media.upload({ siteId, file: upload(await photo({ width: 40, height: 30 }), "cake.jpg") })
		).media;
		expect(file).toMatchObject({ language: "en", title: null, alt: null, caption: null });

		const { media } = await editor.api.media.update({
			siteId,
			mediaId: file.id,
			language: "en",
			title: "  Wedding cake ",
			alt: "A three-tier wedding cake with fresh flowers",
			caption: "Made for the Byrne wedding",
		});
		expect(media).toMatchObject({
			title: "Wedding cake",
			alt: "A three-tier wedding cake with fresh flowers",
			caption: "Made for the Byrne wedding",
		});

		const cleared = (await editor.api.media.update({ siteId, mediaId: file.id, caption: null })).media;
		expect(cleared).toMatchObject({ title: "Wedding cake", caption: null });
	});

	test("a language the Site doesn't have is refused", async () => {
		const file = await uploadPdf("languages.pdf");
		await expect(
			editor.api.media.update({ siteId, mediaId: file.id, language: "de", alt: "Ein Brot" }),
		).rejects.toMatchObject({ code: "MEDIA_INVALID", status: 400 });
		await expect(editor.api.media.get({ siteId, mediaId: file.id, language: "de" })).rejects.toMatchObject({
			code: "MEDIA_INVALID",
		});
	});

	test("an alt text over 1000 characters is refused", async () => {
		const file = await uploadPdf("long.pdf");
		await expect(editor.api.media.update({ siteId, mediaId: file.id, alt: "a".repeat(1001) })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	test("a Media item of another Site isn't found", async () => {
		await expect(editor.api.media.get({ siteId, mediaId: crypto.randomUUID() })).rejects.toMatchObject({
			code: "MEDIA_NOT_FOUND",
			status: 404,
		});
	});
});

describe("the Audit log", () => {
	test("records uploads, changes and folders", async () => {
		const { folder } = await editor.api.media.folders.create({ siteId, name: "Audited" });
		const file = await uploadPdf("audited.pdf", folder.id);
		await editor.api.media.update({ siteId, mediaId: file.id, alt: "Audited file" });

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 10 });
		expect(entries.map((entry) => entry.action).slice(0, 3)).toEqual([
			"media.update",
			"media.upload",
			"mediaFolder.create",
		]);
		expect(entries[0]?.details).toMatchObject({ mediaId: file.id, changed: ["alt"] });
		expect(entries[1]?.details).toMatchObject({ mediaId: file.id, fileName: "audited.pdf" });
	});
});
