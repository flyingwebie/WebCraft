// A big Site is never held in memory: the export reads each table a batch of rows at a time and keeps
// its archive as parts in storage, and the import takes the archive in parts and streams it back in.
// With the thresholds lowered (two rows a batch, 1 KiB parts) a small Site goes through every path a
// big one does, and comes back whole.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { downloadExport, exportSite, importArchive, manifestIn } from "../harness/site-transfer.ts";

const ENTRIES = 25;

let install: TestInstall;
let admin: TestBrowser;
let workspaceId: string;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall({ siteTransfer: { batchRows: 2, partBytes: 1024 } });
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Posts",
		key: "posts",
		urlPattern: "/p/{slug}",
	});
	for (let index = 1; index <= ENTRIES; index++) {
		await admin.api.entries.create({ siteId, postTypeId: postType.id, title: `Loaf number ${index}` });
	}
	await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 300, height: 200 }), "Loaf.jpg", "image/jpeg"),
	});
	await install.drainJobs();
});

afterAll(async () => {
	await install?.close();
});

test("exported a batch of rows at a time into many parts, and imported in parts, the Site comes back whole", async () => {
	const view = await exportSite(install, admin, siteId);
	expect(view.status).toBe("done");
	const parts = readdirSync(join(install.storageDir, workspaceId, siteId, "exports", view.id));
	expect(parts.length).toBe(Math.ceil((view.sizeBytes ?? 0) / 1024));
	expect(parts.length).toBeGreaterThan(5);

	const response = await downloadExport(install, admin, view);
	const archive = new Uint8Array(await response.arrayBuffer());
	expect(archive.length).toBe(view.sizeBytes ?? -1);
	expect(manifestIn(archive).counts.entries).toBe(ENTRIES);

	const otherWorkspaceId = (await install.createWorkspace("Beta Ltd")).id;
	const imported = await importArchive(install, admin, otherWorkspaceId, archive, {
		name: "Beta Bakery",
		slug: "beta-bakery",
		partBytes: 1024,
	});
	expect(imported.status).toBe("done");
	const newSiteId = imported.site?.id ?? "";
	const { postTypes } = await admin.api.postTypes.list({ siteId: newSiteId });
	const posts = postTypes.find((type) => type.key === "posts");
	const { entries } = await admin.api.entries.list({ siteId: newSiteId, postTypeId: posts?.id ?? "" });
	expect(entries.map((entry) => entry.draft.title).sort()).toEqual(
		Array.from({ length: ENTRIES }, (_, index) => `Loaf number ${index + 1}`).sort(),
	);
	expect((await admin.api.media.list({ siteId: newSiteId })).items).toHaveLength(1);
	// The upload's parts are deleted once the import ran.
	expect(readdirSync(join(install.storageDir, otherWorkspaceId, "site-imports", imported.id))).toEqual([]);
});
