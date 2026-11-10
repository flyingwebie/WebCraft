import { afterAll, beforeAll, expect, test } from "bun:test";
import { pdf, upload } from "../harness/images.ts";
import { createFakeS3, createTestInstall, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive, uploadArchive } from "../harness/site-transfer.ts";

let install: TestInstall;
let archive: Uint8Array;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install?.close();
});

test("a large Media file moves from disk into a bucket in bounded parts and is served whole", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Files")).id;
	const siteId = (await install.createSite(workspaceId, { slug: "files" })).id;
	const bytes = new Uint8Array(6 * 1024 * 1024);
	bytes.set(pdf());
	await admin.api.media.upload({ siteId, file: upload(bytes, "brochure.pdf", "application/pdf") });
	archive = await exportedArchive(install, admin, siteId);
	const settings = {
		endpoint: "https://s3.storage.test",
		bucket: "files",
		region: "eu-west-1",
		accessKeyId: "TESTKEY",
		secretAccessKey: "test-secret-key",
	};
	const bucket = createFakeS3(install.http, settings);
	await admin.api.install.storage.update({ kind: "s3", ...settings, prefix: "install", pathStyle: true });
	const imported = await importArchive(install, admin, workspaceId, archive, { name: "Copy", slug: "copy" });
	expect(imported.status).toBe("done");
	const newSiteId = imported.site?.id ?? "";
	const writes = install.http.requests.filter(
		(request) => request.method === "PUT" && request.url.includes(`/${newSiteId}/media/`),
	);
	expect(writes.length).toBeGreaterThan(1);
	for (const request of writes) expect(request.bytes.length).toBeLessThanOrEqual(5 * 1024 * 1024);
	expect(bucket.openUploads).toBe(0);
	const { items } = await admin.api.media.list({ siteId: newSiteId });
	const response = await admin.request(install.adminUrl(`/api/media/${newSiteId}/${items[0]?.url?.split("/").at(-1)}`));
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});

test("the worker checks the current quota even when it changed after the import was queued", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Limited")).id;
	const uploaded = await uploadArchive(admin, workspaceId, archive);
	await admin.api.siteImports.start({
		workspaceId,
		importId: uploaded.id,
		name: "Limited",
		slug: "limited",
		passphrase: null,
	});
	await admin.api.workspaces.setQuota({ workspaceId, quotaBytes: 1024 * 1024 });
	await install.drainJobs();
	const { import: result } = await admin.api.siteImports.get({ workspaceId, importId: uploaded.id });
	expect(result).toMatchObject({ status: "failed", site: null, failure: { reason: "quota" } });
	expect((await admin.api.sites.list({ workspaceId })).sites).toEqual([]);
});
