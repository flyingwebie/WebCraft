// The WordPress import's export file: uploaded in parts (up to 1 GiB, each part checked by its
// SHA-256, the whole by the SHA-256 of the parts' hashes), resumable where it got to, kept privately,
// read by the worker as a stream into a survey of what it holds, and deleted after a day unused.
// A file that isn't a WordPress export, or tries XML's entity tricks, is refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import {
	approveModules,
	OLD_MILL,
	partsDigest,
	sendParts,
	surveyedExport,
	uploadExport,
	WORDPRESS,
} from "./wordpress.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	await approveModules(install);
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId)).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const bytes = new TextEncoder().encode(OLD_MILL);

describe("uploading an export file", () => {
	test("Staff see the WordPress export file among the sources, and whether runs make Redirect rules", async () => {
		const { sources, redirectsOn } = await staff.api.imports.sources({ siteId });
		expect(sources).toEqual([
			expect.objectContaining({
				id: WORDPRESS,
				label: "WordPress export file",
				maxBytes: 1024 ** 3,
				extensions: [".xml"],
			}),
		]);
		expect(redirectsOn).toBe(true);
	});

	test("comes in parts, then the worker surveys it: its types, their counts and keys, and a suggested mapping", async () => {
		const uploaded = await uploadExport(staff.api, siteId);
		expect(uploaded).toMatchObject({ status: "surveying", sizeBytes: bytes.length, receivedBytes: bytes.length });
		expect((await install.drainJobs()).failed).toEqual([]);

		const { file } = await staff.api.imports.file({ siteId, fileId: uploaded.id });
		expect(file.status).toBe("ready");
		const types = Object.fromEntries((file.survey?.types ?? []).map((type) => [type.key, type]));
		// Trashed items, menus and WordPress's own taxonomies stay out.
		expect(Object.keys(types).sort()).toEqual([
			"attachment",
			"category",
			"flavour",
			"page",
			"post",
			"post_tag",
			"product",
		]);
		expect(types.post).toMatchObject({ label: "Posts", holds: "entries", count: 3 });
		expect(types.page).toMatchObject({ label: "Pages", count: 2 });
		expect(types.attachment).toMatchObject({ label: "Media", holds: "media", count: 2 });
		expect(types.category).toMatchObject({ label: "Categories", count: 2 });
		expect(types.flavour).toMatchObject({ label: "Flavour", count: 1 });
		expect(file.survey?.items).toBe(13);
		const keys = Object.fromEntries((types.post?.keys ?? []).map((key) => [key.key, key]));
		expect(keys.content).toMatchObject({ kind: "html", count: 3 });
		expect(keys._thumbnail_id).toMatchObject({ kind: "file", count: 1, sample: "loaf.jpg" });
		expect(keys._seo_meta_description).toMatchObject({
			kind: "text",
			count: 1,
			sample: "Earlier mornings from April.",
		});
		expect(keys.author).toMatchObject({ kind: "text", count: 3, sample: "Mara Quinn" });
		expect(keys["terms:post_tag"]).toMatchObject({ kind: "items", count: 1 });

		// The suggestion: generic patterns only (SEO keys by their words, a system's own `_` keys skipped).
		const post = file.suggested?.types.find((type) => type.type === "post");
		expect(post?.to).toEqual({ newPostType: { name: "Posts" } });
		const to = Object.fromEntries((post?.keys ?? []).map((key) => [key.key, key.to]));
		expect(to.title).toBe("title");
		expect(to.slug).toBe("slug");
		expect(to.content).toEqual({ newField: { key: "body", label: "Body", type: "body" } });
		expect(to._seo_meta_title).toBe("seo.title");
		expect(to._seo_meta_description).toBe("seo.description");
		expect(to._edit_lock).toBeNull();
		expect(to["terms:category"]).toEqual({
			newField: { key: "categories", label: "Categories", type: "relationship", to: "category" },
		});
		const pages = file.suggested?.types.find((type) => type.type === "page");
		const { postTypes } = await staff.api.postTypes.list({ siteId });
		expect(pages?.to).toEqual({ postTypeId: postTypes.find((each) => each.builtIn === "page")?.id ?? "" });
		expect(file.suggested?.types.find((type) => type.type === "attachment")?.to).toBe("media");
	});

	test("goes on where it got to after it stopped, and takes a part sent again as it was", async () => {
		const { file } = await staff.api.imports.startUpload({
			siteId,
			source: WORDPRESS,
			fileName: "export.xml",
			size: bytes.length,
			partBytes: 4 * 1024,
		});
		const first = bytes.slice(0, file.partBytes);
		const firstHash = (await sendParts(staff.api, siteId, file, first))[0] as string;
		const { file: halfway } = await staff.api.imports.file({ siteId, fileId: file.id });
		expect(halfway).toMatchObject({ status: "uploading", receivedBytes: file.partBytes });

		// A part past where the file got to is refused, saying where to go on.
		const third = bytes.slice(2 * file.partBytes, 3 * file.partBytes);
		await expect(
			staff.api.imports.uploadPart({
				siteId,
				fileId: file.id,
				offset: 2 * file.partBytes,
				sha256: createHash("sha256").update(third).digest("hex"),
				part: new Blob([third]),
			}),
		).rejects.toMatchObject({
			code: "IMPORT_UPLOAD_REFUSED",
			data: { reason: "offset", receivedBytes: file.partBytes },
		});
		// The first part again changes nothing.
		await staff.api.imports.uploadPart({
			siteId,
			fileId: file.id,
			offset: 0,
			sha256: firstHash,
			part: new Blob([first]),
		});

		const hashes = await sendParts(staff.api, siteId, file, bytes, file.partBytes);
		const { file: done } = await staff.api.imports.finishUpload({
			siteId,
			fileId: file.id,
			sha256: partsDigest(hashes),
		});
		expect(done).toMatchObject({ status: "surveying", receivedBytes: bytes.length });
	});

	test("refuses a part whose bytes aren't what its SHA-256 says, and a file whose parts don't add up", async () => {
		const { file } = await staff.api.imports.startUpload({
			siteId,
			source: WORDPRESS,
			fileName: "export.xml",
			size: bytes.length,
			partBytes: 4 * 1024,
		});
		await expect(
			staff.api.imports.uploadPart({
				siteId,
				fileId: file.id,
				offset: 0,
				sha256: "0".repeat(64),
				part: new Blob([bytes.slice(0, file.partBytes)]),
			}),
		).rejects.toMatchObject({ code: "IMPORT_UPLOAD_REFUSED", data: { reason: "hash" } });
		await expect(
			staff.api.imports.finishUpload({ siteId, fileId: file.id, sha256: "0".repeat(64) }),
		).rejects.toMatchObject({
			code: "IMPORT_UPLOAD_REFUSED",
			data: { reason: "size" },
		});
		await sendParts(staff.api, siteId, file, bytes);
		await expect(
			staff.api.imports.finishUpload({ siteId, fileId: file.id, sha256: "1".repeat(64) }),
		).rejects.toMatchObject({
			code: "IMPORT_UPLOAD_REFUSED",
			data: { reason: "hash" },
		});
	});

	test("takes files up to 1 GiB, and refuses a larger one before any part comes", async () => {
		const { file } = await staff.api.imports.startUpload({
			siteId,
			source: WORDPRESS,
			fileName: "big.xml",
			size: 1024 ** 3,
		});
		expect(file.partBytes).toBe(8 * 1024 * 1024);
		await expect(
			staff.api.imports.startUpload({ siteId, source: WORDPRESS, fileName: "huge.xml", size: 1024 ** 3 + 1 }),
		).rejects.toMatchObject({ code: "IMPORT_UPLOAD_REFUSED", status: 413, data: { reason: "size" } });
	});

	test("keeps the file privately, never in the Media library, and deletes it after a day unused", async () => {
		const uploaded = await surveyedExport(install, staff.api, siteId);
		const folder = join(install.storageDir, workspaceId, siteId, "imports", uploaded.id);
		expect(readdirSync(folder).length).toBeGreaterThan(1);
		expect((await staff.api.media.list({ siteId })).items).toEqual([]);

		await install.clock.advance(25 * 60 * 60_000);
		expect((await install.drainJobs()).failed).toEqual([]);
		await expect(staff.api.imports.file({ siteId, fileId: uploaded.id })).rejects.toMatchObject({
			code: "IMPORT_FILE_NOT_FOUND",
		});
		expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
	});
});

describe("files the source refuses", () => {
	const refusal = async (text: string | Uint8Array) => {
		const file = await surveyedExport(install, staff.api, siteId, text);
		expect(file.status).toBe("refused");
		return file.refusal?.code;
	};

	test("a document type declaration, so no entity is ever expanded (billion laughs, external entities)", async () => {
		const laughs = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.2</wp:wxr_version><item><title>&c;</title></item></channel></rss>`;
		expect(await refusal(laughs)).toBe("doctype");
		const outside = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.2</wp:wxr_version><item><title>&secret;</title></item></channel></rss>`;
		expect(await refusal(outside)).toBe("doctype");
		expect(install.http.requests.filter((request) => request.url.startsWith("file:"))).toEqual([]);
	});

	test("an entity nobody declared, a file that isn't XML, one that isn't an export, and bytes that aren't UTF-8", async () => {
		expect(
			await refusal(
				'<rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.2</wp:wxr_version><item><title>&nope;</title></item></channel></rss>',
			),
		).toBe("xml");
		expect(await refusal("<rss><channel><item>")).toBe("xml");
		expect(await refusal('<?xml version="1.0"?><html><body>Hello</body></html>')).toBe("notExport");
		expect(await refusal('<rss version="2.0"><channel><item><title>A feed</title></item></channel></rss>')).toBe(
			"notExport",
		);
		expect(await refusal(new Uint8Array([0x3c, 0x72, 0x73, 0x73, 0xff, 0xfe, 0x3e]))).toBe("encoding");
	});
});

describe("who uploads", () => {
	test("Owners and Editors import CSV files only: the WordPress import is Staff's (it makes Post Types)", async () => {
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
		expect((await owner.api.imports.sources({ siteId })).sources).toEqual([]);
		await expect(
			owner.api.imports.startUpload({ siteId, source: WORDPRESS, fileName: "x.xml", size: 10 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("nobody uploads for the source on a Site where its Module is off", async () => {
		const otherSite = (await install.createSite(workspaceId)).id;
		await staff.api.modules.setOnSite({ siteId: otherSite, moduleId: "wordpress-import", on: false });
		expect((await staff.api.imports.sources({ siteId: otherSite })).sources).toEqual([]);
		await expect(
			staff.api.imports.startUpload({ siteId: otherSite, source: WORDPRESS, fileName: "x.xml", size: 10 }),
		).rejects.toMatchObject({ code: "IMPORT_SOURCE_NOT_FOUND" });
	});
});
