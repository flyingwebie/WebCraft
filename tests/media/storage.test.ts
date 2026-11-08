// Where an Install keeps its Media: local disk (the default) or an S3-compatible bucket, one Install
// setting the Superadmin changes (a Sensitive action: the bucket's secret key is a secret). The bucket
// here is a fake behind the fake outgoing HTTP, which checks every request's signature.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pdf, photo, upload } from "../harness/images.ts";
import { createFakeS3, createTestInstall, type FakeS3, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let bucket: FakeS3;
let admin: TestBrowser;
let workspaceId: string;
let siteId: string;

const S3 = {
	endpoint: "https://s3.storage.test",
	bucket: "agency-media",
	region: "eu-west-1",
	accessKeyId: "AKIAWEBCRAFTTEST",
	secretAccessKey: "a-very-secret-access-key-0123456789",
};

/** The S3 settings as the Superadmin enters them. */
const s3Settings = (changes: Partial<typeof S3> & { prefix?: string } = {}) => ({
	kind: "s3" as const,
	endpoint: S3.endpoint,
	region: S3.region,
	bucket: S3.bucket,
	prefix: "install-1",
	pathStyle: true,
	accessKeyId: S3.accessKeyId,
	secretAccessKey: S3.secretAccessKey,
	...changes,
});

beforeAll(async () => {
	install = await createTestInstall();
	bucket = createFakeS3(install.http, S3);
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
});

afterAll(async () => {
	await install.close();
});

const onSite = (path: string) => `https://bakery.sites.test${path}`;

describe("storage", () => {
	let onDisk: { url: string; bytes: Uint8Array<ArrayBuffer> };

	test("local disk is the default", async () => {
		expect(await admin.api.install.storage.get()).toMatchObject({ kind: "disk", s3: null });

		const bytes = pdf("Stored on disk");
		const { media } = await admin.api.media.upload({ siteId, file: upload(bytes, "on-disk.pdf") });
		onDisk = { url: media.url ?? "", bytes };
		expect(existsSync(join(install.storageDir, workspaceId, siteId, "media", onDisk.url.replace("/_media/", "")))).toBe(
			true,
		);
		expect(bucket.objects.size).toBe(0);
	});

	test("a bucket WebCraft can't write to is refused, and nothing changes", async () => {
		await expect(
			admin.api.install.storage.update(s3Settings({ secretAccessKey: "the-wrong-secret-key" })),
		).rejects.toMatchObject({ code: "STORAGE_UNREACHABLE", status: 400 });
		await expect(admin.api.install.storage.update(s3Settings({ bucket: "missing-bucket" }))).rejects.toMatchObject({
			code: "STORAGE_UNREACHABLE",
		});
		expect(await admin.api.install.storage.get()).toMatchObject({ kind: "disk", s3: null });
	});

	test("switching to an S3-compatible bucket checks it, keeps the secret key write-only and records the change", async () => {
		const settings = await admin.api.install.storage.update(s3Settings());

		expect(settings).toMatchObject({
			kind: "s3",
			s3: {
				endpoint: S3.endpoint,
				region: S3.region,
				bucket: S3.bucket,
				prefix: "install-1",
				pathStyle: true,
				accessKeyId: S3.accessKeyId,
				secretAccessKey: { set: true, lastFour: "6789" },
			},
		});
		expect(JSON.stringify(settings)).not.toContain(S3.secretAccessKey);
		// The check wrote, read and removed an object of its own.
		expect(bucket.requests.filter((request) => request.signed).map((request) => request.method)).toEqual(
			expect.arrayContaining(["PUT", "GET", "DELETE"]),
		);
		expect(bucket.objects.size).toBe(0);

		const { entries } = await admin.api.audit.list({ limit: 5 });
		const change = entries.find((entry) => entry.action === "storage.change");
		expect(change?.details).toMatchObject({ kind: "s3", endpoint: S3.endpoint, bucket: S3.bucket });
		expect(JSON.stringify(entries)).not.toContain(S3.secretAccessKey);
	});

	test("uploads then go to the bucket, under one folder per Workspace and Site, and are served from it", async () => {
		const bytes = pdf("Stored in the bucket");
		const { media } = await admin.api.media.upload({ siteId, file: upload(bytes, "in-bucket.pdf") });
		const name = (media.url ?? "").replace("/_media/", "");

		expect(bucket.objects.get(`install-1/${workspaceId}/${siteId}/media/${name}`)?.body).toEqual(bytes);
		expect(existsSync(join(install.storageDir, workspaceId, siteId, "media", name))).toBe(false);

		const response = await install.request(onSite(media.url ?? ""));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

		const part = await install.request(onSite(media.url ?? ""), { headers: { range: "bytes=0-3" } });
		expect(part.status).toBe(206);
		expect(await part.text()).toBe("%PDF");
		expect(bucket.requests.every((request) => request.signed)).toBe(false); // the refused tries above
		expect(bucket.requests.slice(-3).every((request) => request.signed)).toBe(true);
	});

	test("the worker reads the raw upload from the bucket and writes the original and its variants there", async () => {
		const { media } = await admin.api.media.upload({
			siteId,
			file: upload(await photo({ width: 700, height: 400, camera: true }), "loaf.jpg"),
		});
		expect(bucket.objects.has(`install-1/${workspaceId}/${siteId}/uploads/${media.id}`)).toBe(true);

		expect((await install.drainJobs()).failed).toEqual([]);
		const ready = (await admin.api.media.get({ siteId, mediaId: media.id })).media;

		expect(bucket.objects.has(`install-1/${workspaceId}/${siteId}/uploads/${media.id}`)).toBe(false);
		for (const url of [ready.url ?? "", ...ready.variants.map((variant) => variant.url)]) {
			expect(bucket.objects.has(`install-1/${workspaceId}/${siteId}/media/${url.replace("/_media/", "")}`)).toBe(true);
			expect((await install.request(onSite(url))).status).toBe(200);
		}
	});

	test("files stored before the switch are still served from where they are", async () => {
		const response = await install.request(onSite(onDisk.url));
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(onDisk.bytes);
	});

	test("leaving the secret key out keeps it; switching back to disk keeps files in the bucket readable", async () => {
		const { secretAccessKey: _, ...withoutSecret } = s3Settings({ prefix: "install-1" });
		expect(await admin.api.install.storage.update(withoutSecret)).toMatchObject({
			kind: "s3",
			s3: { secretAccessKey: { set: true, lastFour: "6789" } },
		});

		const { media } = await admin.api.media.upload({ siteId, file: upload(pdf("Bucket file"), "kept.pdf") });
		expect(await admin.api.install.storage.update({ kind: "disk" })).toMatchObject({ kind: "disk" });

		expect((await install.request(onSite(media.url ?? ""))).status).toBe(200);
		const { media: next } = await admin.api.media.upload({ siteId, file: upload(pdf("Disk again"), "disk-again.pdf") });
		const name = (next.url ?? "").replace("/_media/", "");
		expect(existsSync(join(install.storageDir, workspaceId, siteId, "media", name))).toBe(true);
	});

	test("only the Superadmin sees or changes where Media is stored", async () => {
		const { browser: staff } = await install.createStaff({ workspaces: "all" });
		await expect(staff.api.install.storage.get()).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
		await expect(staff.api.install.storage.update({ kind: "disk" })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("an S3 endpoint must be an http or https address", async () => {
		await expect(
			admin.api.install.storage.update(s3Settings({ endpoint: "ftp://files.example" })),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
