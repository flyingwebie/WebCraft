// The order of a Site's Media folders (FX-03): A–Z by name as the Site's Default language sorts names
// (the default), or the Site's own order, arranged by people who manage the folders. Both the choice
// and the order are the Site's, so everyone sees the same column.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let editor: TestBrowser;
let author: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId)).id;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
});

afterAll(async () => {
	await install.close();
});

async function names(site = siteId, browser = editor) {
	const listed = await browser.api.media.folders.list({ siteId: site });
	return { order: listed.order, names: listed.folders.map((folder) => folder.name) };
}

async function makeFolders(site: string, ...folderNames: string[]) {
	const made: Record<string, string> = {};
	for (const name of folderNames)
		made[name] = (await editor.api.media.folders.create({ siteId: site, name })).folder.id;
	return made;
}

describe("A–Z, the default", () => {
	test("sorts names as people read them: case and accents aside, numbers by their value", async () => {
		const site = (await install.createSite(workspaceId)).id;
		await makeFolders(site, "Zebra", "Été", "apple", "Photos 10", "Photos 9");
		expect(await names(site)).toEqual({
			order: "name",
			names: ["apple", "Été", "Photos 9", "Photos 10", "Zebra"],
		});
	});

	test("follows the Site's Default language", async () => {
		const site = (await install.createSite(workspaceId)).id;
		await makeFolders(site, "Öl", "Zucker", "Apfel");
		expect((await names(site)).names).toEqual(["Apfel", "Öl", "Zucker"]);

		// In Swedish, Ö comes after Z.
		const staff = await install.superadmin();
		await staff.api.languages.add({ siteId: site, code: "sv" });
		const asked = await staff.api.languages.setDefault({ siteId: site, code: "sv" });
		if (asked.changed) throw new Error("It should ask first.");
		await staff.api.languages.setDefault({ siteId: site, code: "sv", confirmation: asked.confirmation.id });
		expect((await names(site)).names).toEqual(["Apfel", "Zucker", "Öl"]);
	});
});

describe("the Site's own order", () => {
	test("starts in the order the folders were made, and a new folder comes last", async () => {
		const site = (await install.createSite(workspaceId)).id;
		await makeFolders(site, "Cakes", "Bread", "Team");
		const custom = await editor.api.media.folders.setOrder({ siteId: site, order: "custom" });
		expect(custom.order).toBe("custom");
		// Folders made one after another keep the order they were made in.
		expect(custom.folders.map((folder) => folder.name)).toEqual(["Cakes", "Bread", "Team"]);

		await makeFolders(site, "Archive");
		expect((await names(site)).names).toEqual(["Cakes", "Bread", "Team", "Archive"]);
	});

	test("is arranged with reorder, kept for the Site, and shown to everyone", async () => {
		const made = await makeFolders(siteId, "Products", "Blog", "Team", "Events");
		await editor.api.media.folders.setOrder({ siteId, order: "custom" });

		const arranged = await editor.api.media.folders.reorder({
			siteId,
			folderIds: [made.Team, made.Products, made.Events, made.Blog].map(String),
		});
		expect(arranged.folders.map((folder) => folder.name)).toEqual(["Team", "Products", "Events", "Blog"]);

		// An Author can't arrange the folders, but sees them as arranged.
		expect(await names(siteId, author)).toEqual({ order: "custom", names: ["Team", "Products", "Events", "Blog"] });
	});

	test("moving one folder: the ids given come first, the rest follow as they were", async () => {
		const site = (await install.createSite(workspaceId)).id;
		const made = await makeFolders(site, "One", "Two", "Three", "Four");
		await editor.api.media.folders.setOrder({ siteId: site, order: "custom" });
		const moved = await editor.api.media.folders.reorder({ siteId: site, folderIds: [String(made.Three)] });
		expect(moved.folders.map((folder) => folder.name)).toEqual(["Three", "One", "Two", "Four"]);
	});

	test("A–Z again leaves the arranged order kept for later", async () => {
		const site = (await install.createSite(workspaceId)).id;
		const made = await makeFolders(site, "b", "a", "c");
		await editor.api.media.folders.setOrder({ siteId: site, order: "custom" });
		await editor.api.media.folders.reorder({ siteId: site, folderIds: [made.c, made.a, made.b].map(String) });

		expect(
			(await editor.api.media.folders.setOrder({ siteId: site, order: "name" })).folders.map((f) => f.name),
		).toEqual(["a", "b", "c"]);
		expect(
			(await editor.api.media.folders.setOrder({ siteId: site, order: "custom" })).folders.map((f) => f.name),
		).toEqual(["c", "a", "b"]);
	});

	test("refuses a folder that isn't the Site's", async () => {
		const other = (await install.createSite(workspaceId)).id;
		const { folder } = await editor.api.media.folders.create({ siteId: other, name: "Elsewhere" });
		await expect(editor.api.media.folders.reorder({ siteId, folderIds: [folder.id] })).rejects.toMatchObject({
			code: "MEDIA_FOLDER_NOT_FOUND",
			status: 404,
		});
	});
});

describe("who may change it", () => {
	test("Authors can't set the order or arrange the folders", async () => {
		await expect(author.api.media.folders.setOrder({ siteId, order: "name" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(author.api.media.folders.reorder({ siteId, folderIds: [] })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("both changes are in the Audit log", async () => {
		const site = (await install.createSite(workspaceId)).id;
		const made = await makeFolders(site, "x", "y");
		await editor.api.media.folders.setOrder({ siteId: site, order: "custom" });
		await editor.api.media.folders.reorder({ siteId: site, folderIds: [made.y, made.x].map(String) });
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 5 });
		expect(entries.slice(0, 2).map((entry) => [entry.action, entry.details])).toEqual([
			["mediaFolder.reorder", { folderIds: [made.y, made.x] }],
			["mediaFolder.order", { order: "custom" }],
		]);
	});
});
