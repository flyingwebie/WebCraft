// Who does what in a Site's Media library: everyone who reaches the Site sees it and uploads to it;
// Authors change only their own uploads; Editors, Owners and Staff change every file and the folders.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pdf, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let author: TestBrowser;
let otherAuthor: TestBrowser;
let editor: TestBrowser;
let owner: TestBrowser;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId)).id;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	otherAuthor = (await install.createMember({ workspaceId, role: "author" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const uploadAs = async (browser: TestBrowser, name: string) =>
	(await browser.api.media.upload({ siteId, file: upload(pdf(name), name) })).media;

describe("Authors", () => {
	test("upload, and change their own uploads", async () => {
		const mine = await uploadAs(author, "mine.pdf");
		expect(mine.canEdit).toBe(true);

		const { media } = await author.api.media.update({ siteId, mediaId: mine.id, title: "My file" });
		expect(media.title).toBe("My file");
	});

	test("see every file of the Site, but can't change someone else's", async () => {
		const theirs = await uploadAs(editor, "theirs.pdf");
		const seen = (await author.api.media.get({ siteId, mediaId: theirs.id })).media;
		expect(seen.canEdit).toBe(false);
		expect((await author.api.media.list({ siteId })).items.map((item) => item.id)).toContain(theirs.id);

		await expect(author.api.media.update({ siteId, mediaId: theirs.id, alt: "Changed" })).rejects.toMatchObject({
			code: "FORBIDDEN",
			status: 403,
		});
		const other = await uploadAs(otherAuthor, "other-author.pdf");
		await expect(author.api.media.update({ siteId, mediaId: other.id, alt: "Changed" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("can't make, rename or delete folders, but file their own uploads in one", async () => {
		await expect(author.api.media.folders.create({ siteId, name: "Mine" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const { folder } = await editor.api.media.folders.create({ siteId, name: "Shared" });
		await expect(author.api.media.folders.rename({ siteId, folderId: folder.id, name: "X" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(author.api.media.folders.delete({ siteId, folderId: folder.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		const mine = await uploadAs(author, "to-file.pdf");
		const filed = (await author.api.media.update({ siteId, mediaId: mine.id, folderId: folder.id })).media;
		expect(filed.folderId).toBe(folder.id);
		const direct = (await author.api.media.upload({ siteId, file: upload(pdf(), "direct.pdf"), folderId: folder.id }))
			.media;
		expect(direct.folderId).toBe(folder.id);
	});
});

describe("Editors, Owners and Staff", () => {
	for (const [role, browser] of [
		["editor", () => editor],
		["owner", () => owner],
		["staff", () => staff],
	] as const) {
		test(`${role}: changes every upload and manages folders`, async () => {
			const authors = await uploadAs(author, `by-author-for-${role}.pdf`);
			const seen = (await browser().api.media.get({ siteId, mediaId: authors.id })).media;
			expect(seen.canEdit).toBe(true);
			const { media } = await browser().api.media.update({ siteId, mediaId: authors.id, alt: `Checked by ${role}` });
			expect(media.alt).toBe(`Checked by ${role}`);

			const { folder } = await browser().api.media.folders.create({ siteId, name: `Folder of ${role}` });
			await browser().api.media.folders.rename({ siteId, folderId: folder.id, name: `Renamed by ${role}` });
			await browser().api.media.folders.delete({ siteId, folderId: folder.id });
		});
	}
});

describe("people outside the Site", () => {
	test("a Member who doesn't reach the Site can't see its Media library", async () => {
		const otherSiteId = (await install.createSite(workspaceId)).id;
		const outsider = (await install.createMember({ workspaceId, role: "editor", sites: [otherSiteId] })).browser;
		const file = await uploadAs(editor, "private-to-site.pdf");

		await expect(outsider.api.media.list({ siteId })).rejects.toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
		await expect(outsider.api.media.get({ siteId, mediaId: file.id })).rejects.toMatchObject({
			code: "SITE_NOT_FOUND",
		});
		await expect(outsider.api.media.upload({ siteId, file: upload(pdf(), "x.pdf") })).rejects.toMatchObject({
			code: "SITE_NOT_FOUND",
		});
	});

	test("signed-out people get nothing", async () => {
		await expect(install.browser().api.media.list({ siteId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
