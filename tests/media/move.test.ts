// Moving stored Media between local disk and an S3-compatible bucket (`webcraft admin media move`,
// run here as the command runs it): every stored file is copied, checked, its rows pointed at the new
// storage and the old copy removed, without changing a single address. A move that stopped is run
// again and goes on. The bucket is a fake behind the fake outgoing HTTP, checking every signature.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { pdf, photo, upload } from "../harness/images.ts";
import { createFakeS3, createTestInstall, type FakeS3, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let bucket: FakeS3;
let admin: TestBrowser;
let workspaceId: string;
let siteId: string;
let files: { url: string; bytes: Uint8Array }[];

const S3 = {
	endpoint: "https://s3.storage.test",
	bucket: "agency-media",
	region: "eu-west-1",
	accessKeyId: "AKIAWEBCRAFTTEST",
	secretAccessKey: "a-very-secret-access-key-0123456789",
};

const onSite = (path: string) => `https://bakery.live.test${path}`;

/** Every file under the Site's local storage folder. */
function localFiles(): string[] {
	const folder = join(install.storageDir, workspaceId, siteId, "media");
	return existsSync(folder) ? readdirSync(folder) : [];
}

beforeAll(async () => {
	install = await createTestInstall();
	bucket = createFakeS3(install.http, S3);
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	await goLive(install, siteId);
	files = [];
	for (const name of ["menu.pdf", "prices.pdf"]) {
		const bytes = pdf(name);
		const { media } = await admin.api.media.upload({ siteId, file: upload(bytes, name) });
		files.push({ url: media.url ?? "", bytes });
	}
	// An image has an original and variants: every one of them moves.
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 700, height: 400 }), "loaf.jpg"),
	});
	await install.drainJobs();
	const { media: processed } = await admin.api.media.get({ siteId, mediaId: media.id });
	files.push({
		url: processed.url ?? "",
		bytes: new Uint8Array(await (await install.request(onSite(processed.url ?? ""))).arrayBuffer()),
	});
});

afterAll(async () => {
	await install.close();
});

async function served(url: string): Promise<Uint8Array> {
	const response = await install.request(onSite(url));
	expect(response.status).toBe(200);
	return new Uint8Array(await response.arrayBuffer());
}

describe("moving Media to a bucket", () => {
	test("is refused while new files still go to local disk", async () => {
		await expect(install.moveMedia({ to: "s3" })).rejects.toThrow("No S3-compatible bucket is set");
		await admin.api.install.storage.update({ kind: "s3", ...S3, prefix: "install-1", pathStyle: true });
		await admin.api.install.storage.update({ kind: "disk" });

		await expect(install.moveMedia({ to: "s3" })).rejects.toThrow("New files go to local disk");
	});

	test("moves every stored file, keeping every address, and leaves nothing on disk", async () => {
		const before = localFiles().length;
		expect(before).toBeGreaterThan(3);
		await admin.api.install.storage.update({ kind: "s3", ...S3, prefix: "install-1", pathStyle: true });

		const report = await install.moveMedia({ to: "s3" });

		expect(report).toMatchObject({ to: "s3", moved: before, missing: [], left: 0 });
		expect(localFiles()).toEqual([]);
		expect(
			[...bucket.objects.keys()].filter((key) => key.startsWith(`install-1/${workspaceId}/${siteId}/media/`)),
		).toHaveLength(before);
		for (const file of files) expect(await served(file.url)).toEqual(file.bytes);
		expect(bucket.requests.every((request) => request.signed)).toBe(true);
	});

	test("run again, it has nothing left to move", async () => {
		expect(await install.moveMedia({ to: "s3" })).toMatchObject({ moved: 0, missing: [], left: 0 });
	});
});

describe("moving Media back to local disk", () => {
	test("a file missing from the bucket is said and left; once it is back, the move goes on", async () => {
		await admin.api.install.storage.update({ kind: "disk" });
		const objects = bucket.objects as Map<string, { body: Uint8Array; contentType: string | null }>;
		const [missingKey, missingObject] = [...objects].find(([key]) => key.endsWith(".pdf")) ?? [];
		objects.delete(missingKey ?? "");

		const first = await install.moveMedia({ to: "disk", keepSource: true });
		expect(first.missing).toEqual([(missingKey ?? "").replace("install-1/", "")]);
		expect(first.left).toBe(1);
		expect(first.moved).toBe(localFiles().length);

		objects.set(missingKey ?? "", missingObject as { body: Uint8Array; contentType: string | null });
		const second = await install.moveMedia({ to: "disk" });
		expect(second).toMatchObject({ moved: 1, missing: [], left: 0 });
		for (const file of files) expect(await served(file.url)).toEqual(file.bytes);
	});
});
