// Uploading to a Site's Media library, what the worker does to images (ADR 0027), and how files are
// served on the Site's own domain under /_media/ (ADR 0026).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canMakeHeic, heicPhoto, imageInfo, pdf, photo, pixel, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

/** A URL on the Site's Staging address. */
const onSite = (path: string) => `https://bakery.sites.test${path}`;

/** Uploads a file as the Editor, runs the worker's jobs, and answers the Media item as it is then. */
async function uploadAndProcess(file: File) {
	const { media } = await editor.api.media.upload({ siteId, file });
	const report = await install.drainJobs();
	expect(report.failed).toEqual([]);
	return (await editor.api.media.get({ siteId, mediaId: media.id })).media;
}

async function served(path: string) {
	const response = await install.request(onSite(path));
	expect(response.status).toBe(200);
	return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

describe("images", () => {
	test("the worker strips camera and GPS data and turns the photo upright before anyone can see it", async () => {
		const original = await photo({ width: 700, height: 500, orientation: 6, camera: true });
		expect(await imageInfo(original)).toMatchObject({ gps: true, camera: true, orientation: 6 });

		const { media } = await editor.api.media.upload({
			siteId,
			file: upload(original, "Sourdough Loaf.JPG", "image/jpeg"),
		});

		// Until the worker has cleaned it, the photo has no public address at all.
		expect(media).toMatchObject({ kind: "image", fileName: "Sourdough Loaf.JPG", status: "processing", url: null });
		expect(media.variants).toEqual([]);

		expect((await install.drainJobs()).failed).toEqual([]);
		const ready = (await editor.api.media.get({ siteId, mediaId: media.id })).media;

		expect(ready).toMatchObject({ status: "ready", width: 500, height: 700, contentType: "image/jpeg" });
		expect(ready.url).toMatch(/^\/_media\/[0-9a-f]{16}-sourdough-loaf\.jpg$/);

		const { response, bytes } = await served(ready.url ?? "");
		expect(response.headers.get("content-type")).toBe("image/jpeg");
		expect(await imageInfo(bytes)).toMatchObject({
			format: "jpeg",
			width: 500,
			height: 700,
			orientation: undefined,
			exif: false,
			xmp: false,
			gps: false,
			camera: false,
		});
		// The left (red) half of the stored photo is its top once turned a quarter clockwise.
		expect((await pixel(bytes, 250, 20))[0]).toBeGreaterThan(200);
		expect((await pixel(bytes, 250, 680))[2]).toBeGreaterThan(200);
	});

	test("the name carries the file's content hash, and the answer can be cached forever", async () => {
		const ready = await uploadAndProcess(upload(await photo({ width: 400, height: 300 }), "croissants.jpg"));
		const { response, bytes } = await served(ready.url ?? "");

		const hash = /^\/_media\/([0-9a-f]{16})-/.exec(ready.url ?? "")?.[1];
		expect(
			createHash("sha256")
				.update(bytes)
				.digest("hex")
				.startsWith(hash ?? "-"),
		).toBe(true);
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("etag")).toBe(`"${hash}"`);
		expect(response.headers.get("content-length")).toBe(String(bytes.length));
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		// Media is never a page: the page cache doesn't keep it.
		expect(response.headers.get("x-cache")).toBeNull();
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
	});

	test("variants: every fixed width up to the original's, each in AVIF and WebP, never larger", async () => {
		const ready = await uploadAndProcess(upload(await photo({ width: 1000, height: 600 }), "shop-front.jpg"));

		expect(ready.variants.map((variant) => `${variant.format} ${variant.width}x${variant.height}`).sort()).toEqual([
			"avif 320x192",
			"avif 640x384",
			"avif 960x576",
			"webp 320x192",
			"webp 640x384",
			"webp 960x576",
		]);
		for (const variant of ready.variants) {
			expect(variant.url).toMatch(new RegExp(`^/_media/[0-9a-f]{16}-shop-front-${variant.width}\\.${variant.format}$`));
			const { response, bytes } = await served(variant.url);
			expect(response.headers.get("content-type")).toBe(`image/${variant.format}`);
			const info = await imageInfo(bytes);
			expect(info).toMatchObject({ width: variant.width, height: variant.height, exif: false });
			expect(info.format).toBe(variant.format === "avif" ? "heif" : "webp");
		}
	});

	test("a photo exactly as wide as a width gets that width too; one narrower than the smallest gets none", async () => {
		const exact = await uploadAndProcess(upload(await photo({ width: 640, height: 320 }), "exact.jpg"));
		expect(exact.variants.map((variant) => variant.width).sort()).toEqual([320, 320, 640, 640]);

		const small = await uploadAndProcess(upload(await photo({ width: 200, height: 100 }), "small.jpg"));
		expect(small.variants).toEqual([]);
		expect(small.status).toBe("ready");
		await served(small.url ?? "");
	});

	test("PNG, WebP and AVIF photos keep their own format as the original", async () => {
		for (const format of ["png", "webp", "avif"] as const) {
			const ready = await uploadAndProcess(upload(await photo({ width: 120, height: 80, format }), `logo.${format}`));
			expect(ready.contentType).toBe(`image/${format}`);
			expect(ready.url).toMatch(new RegExp(`-logo\\.${format}$`));
			const { response } = await served(ready.url ?? "");
			expect(response.headers.get("content-type")).toBe(`image/${format}`);
		}
	});

	test.skipIf(!canMakeHeic)("a HEIC photo from a phone becomes a JPEG", async () => {
		const heic = await heicPhoto({ width: 64, height: 48 });
		const ready = await uploadAndProcess(upload(heic ?? new Uint8Array(), "IMG_0001.HEIC", "image/heic"));

		expect(ready).toMatchObject({ status: "ready", contentType: "image/jpeg", width: 64, height: 48 });
		expect(ready.fileName).toBe("IMG_0001.HEIC");
		expect(ready.url).toMatch(/-img-0001\.jpg$/);
		const { bytes } = await served(ready.url ?? "");
		expect(await imageInfo(bytes)).toMatchObject({ format: "jpeg", width: 64, height: 48 });
	});

	test.skipIf(!canMakeHeic)("a HEIC photo larger than the worker reads is refused before it is decoded", async () => {
		// The real limit is some 268 million pixels; a small one stands in for it, without a huge file.
		const small = await createTestInstall({ maxImagePixels: 1_000 });
		try {
			const smallWorkspace = (await small.createWorkspace("Small Ltd")).id;
			const smallSite = (await small.createSite(smallWorkspace, { name: "Small", slug: "small" })).id;
			const smallEditor = (await small.createMember({ workspaceId: smallWorkspace, role: "editor" })).browser;
			const heic = await heicPhoto({ width: 64, height: 48 });

			const { media } = await smallEditor.api.media.upload({
				siteId: smallSite,
				file: upload(heic ?? new Uint8Array(), "IMG_0002.HEIC", "image/heic"),
			});
			await small.drainJobs();

			expect((await smallEditor.api.media.get({ siteId: smallSite, mediaId: media.id })).media).toMatchObject({
				status: "failed",
			});
		} finally {
			await small.close();
		}
	});

	test("a file that claims to be an image but can't be read fails, and is never served", async () => {
		const broken = new Uint8Array([
			0xff,
			0xd8,
			0xff,
			0xe0,
			0x00,
			0x10,
			...new TextEncoder().encode("not really a JPEG"),
		]);
		const { media } = await editor.api.media.upload({ siteId, file: upload(broken, "broken.jpg", "image/jpeg") });
		await install.drainJobs();

		const after = (await editor.api.media.get({ siteId, mediaId: media.id })).media;
		expect(after).toMatchObject({ status: "failed", url: null });
	});
});

describe("other files", () => {
	test("documents are served as uploaded, at once", async () => {
		const bytes = pdf();
		const { media } = await editor.api.media.upload({ siteId, file: upload(bytes, "Allergen Guide.pdf") });

		expect(media).toMatchObject({ kind: "document", status: "ready", contentType: "application/pdf" });
		expect(media.url).toMatch(/^\/_media\/[0-9a-f]{16}-allergen-guide\.pdf$/);
		const { response, bytes: back } = await served(media.url ?? "");
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(back).toEqual(bytes);
	});

	test("anything that isn't what it claims to be is refused (SVGs go to the worker: tests/media/svg.test.ts)", async () => {
		const page = "<!doctype html><html><body><script>steal()</script></body></html>";
		await expect(
			editor.api.media.upload({ siteId, file: upload(page, "photo.jpg", "image/jpeg") }),
		).rejects.toMatchObject({ code: "MEDIA_TYPE_REFUSED", data: { reason: "unknown" } });

		await expect(editor.api.media.upload({ siteId, file: upload("", "empty.pdf") })).rejects.toMatchObject({
			code: "MEDIA_TYPE_REFUSED",
			data: { reason: "unknown" },
		});
	});

	test("a file over the size limit is refused", async () => {
		const huge = new Uint8Array(50 * 1024 * 1024 + 1);
		huge.set(pdf());
		await expect(editor.api.media.upload({ siteId, file: upload(huge, "huge.pdf") })).rejects.toMatchObject({
			code: "MEDIA_TOO_LARGE",
			status: 413,
			data: { maxBytes: 50 * 1024 * 1024 },
		});
	});
});

describe("storage on local disk", () => {
	test("files live in one folder per Workspace and Site; the raw upload sits apart until the worker removes it", async () => {
		const { media } = await editor.api.media.upload({
			siteId,
			file: upload(await photo({ width: 700, height: 400, camera: true }), "wedding.jpg"),
		});
		const siteFolder = join(install.storageDir, workspaceId, siteId);
		expect(readdirSync(join(siteFolder, "uploads"))).toContain(media.id);

		await install.drainJobs();
		const ready = (await editor.api.media.get({ siteId, mediaId: media.id })).media;

		expect(readdirSync(join(siteFolder, "uploads"))).not.toContain(media.id);
		const stored = readdirSync(join(siteFolder, "media"));
		for (const url of [ready.url, ...ready.variants.map((variant) => variant.url)]) {
			expect(stored).toContain((url ?? "").replace("/_media/", ""));
		}
		expect(existsSync(join(install.storageDir, workspaceId, siteId, "media"))).toBe(true);
	});
});

describe("/_media/ on the Site's domain", () => {
	test("answers only this Site's own files", async () => {
		const otherSiteId = (await install.createSite(workspaceId, { slug: "cafe" })).id;
		const admin = await install.superadmin();
		const { media } = await admin.api.media.upload({ siteId: otherSiteId, file: upload(pdf(), "menu.pdf") });

		expect((await install.request(`https://cafe.sites.test${media.url}`)).status).toBe(200);
		expect((await install.request(onSite(media.url ?? ""))).status).toBe(404);
		for (const path of ["/_media/", "/_media", "/_media/0000000000000000-nothing.jpg", `${media.url}/more`]) {
			const response = await install.request(onSite(path));
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		}
	});

	test("conditional, partial and HEAD requests", async () => {
		const bytes = pdf("A longer document for partial requests");
		const { media } = await editor.api.media.upload({ siteId, file: upload(bytes, "partial.pdf") });
		const url = onSite(media.url ?? "");
		const etag = (await install.request(url)).headers.get("etag") ?? "";

		const notModified = await install.request(url, { headers: { "if-none-match": etag } });
		expect(notModified.status).toBe(304);
		expect(await notModified.text()).toBe("");

		const part = await install.request(url, { headers: { range: "bytes=0-7" } });
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe(`bytes 0-7/${bytes.length}`);
		expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(0, 8));

		const tail = await install.request(url, { headers: { range: "bytes=-4" } });
		expect(tail.status).toBe(206);
		expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.subarray(bytes.length - 4));

		const outside = await install.request(url, { headers: { range: `bytes=${bytes.length}-` } });
		expect(outside.status).toBe(416);
		expect(outside.headers.get("content-range")).toBe(`bytes */${bytes.length}`);

		const head = await install.request(url, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(bytes.length));
		expect(await head.text()).toBe("");

		expect((await install.request(url, { method: "POST" })).status).toBe(405);
	});
});
