// A Site export carries how the Site lists its Media folders (A–Z or its own order) and the order
// itself (FX-03); an archive written before folders had an order comes in A–Z, as it was shown.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive, manifestIn, rewritten, rowsIn } from "../harness/site-transfer.ts";

let install: TestInstall;
let admin: TestBrowser;
let archive: Uint8Array;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const ids: string[] = [];
	for (const name of ["Blog", "Products", "Team"])
		ids.push((await admin.api.media.folders.create({ siteId, name })).folder.id);
	await admin.api.media.folders.setOrder({ siteId, order: "custom" });
	await admin.api.media.folders.reorder({ siteId, folderIds: [ids[2], ids[0], ids[1]].map(String) });
	archive = await exportedArchive(install, admin, siteId);
});

afterAll(async () => {
	await install?.close();
});

const listed = async (siteId: string) => {
	const { order, folders } = await admin.api.media.folders.list({ siteId });
	return { order, names: folders.map((folder) => folder.name) };
};

describe("the Media folders' order in a Site export", () => {
	test("is in the archive: the Site's choice and each folder's place", () => {
		expect(manifestIn(archive).site.settings.media_folder_order).toBe("custom");
		const rows = rowsIn(archive, "public.media_folders");
		expect(rows.map((row) => [row.name, row.sort_order]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
			["Team", 0],
			["Blog", 1],
			["Products", 2],
		]);
	});

	test("comes back with the imported Site", async () => {
		const workspaceId = (await install.createWorkspace("Imports")).id;
		const imported = await importArchive(install, admin, workspaceId, archive, { name: "Copy", slug: "copy" });
		expect(imported.status).toBe("done");
		expect(await listed(imported.site?.id ?? "")).toEqual({ order: "custom", names: ["Team", "Blog", "Products"] });
	});

	test("from an archive written before folders had an order, is A–Z", async () => {
		const older = rewritten(archive, {
			manifest: (manifest) => {
				delete manifest.site.settings.media_folder_order;
				manifest.migrations = manifest.migrations.filter((name: string) => !/media-folder-order/.test(name));
				const table = manifest.tables.find((each: { name: string }) => each.name === "public.media_folders");
				table.columns = table.columns.filter((column: string) => column !== "sort_order");
			},
			rows: (table, rows) => (table === "public.media_folders" ? rows.map(({ sort_order: _, ...row }) => row) : rows),
		});
		const workspaceId = (await install.createWorkspace("Older imports")).id;
		const imported = await importArchive(install, admin, workspaceId, older, { name: "Older", slug: "older" });
		expect(imported.status).toBe("done");
		expect(await listed(imported.site?.id ?? "")).toEqual({ order: "name", names: ["Blog", "Products", "Team"] });

		// Switched to its own order, the folders keep the order they were shown in.
		const custom = await admin.api.media.folders.setOrder({ siteId: imported.site?.id ?? "", order: "custom" });
		expect(custom.folders.map((folder) => folder.name)).toEqual(["Blog", "Products", "Team"]);
	});
});
