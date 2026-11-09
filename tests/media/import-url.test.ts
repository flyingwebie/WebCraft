// Import from URL: a file is fetched through the guarded fetcher (each connection pinned to the
// address it checked, at most 3 redirects each checked again, time and size limits, the Install's
// largest file) and then treated exactly as an upload. Every refusal is proved here: addresses
// inside a network after DNS and after each redirect, too many redirects, too large, too slow, and a
// DNS answer that changes between the check and the connection.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const PUBLIC = "93.184.216.34";
const OTHER_PUBLIC = "93.184.216.35";
/** How long the test Install waits for an import (the real wait is 30 seconds). */
const IMPORT_TIMEOUT_MS = 1500;

let install: TestInstall;
let siteId: string;
let author: TestBrowser;
let image: Uint8Array;

beforeAll(async () => {
	install = await createTestInstall({ mediaImportTimeoutMs: IMPORT_TIMEOUT_MS });
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId)).id;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	image = await photo({ width: 400, height: 300 });
	install.dns.answer("photos.example", [PUBLIC]);
	install.dns.answer("cdn.example", [OTHER_PUBLIC]);
});

afterAll(async () => {
	await install.close();
});

/** Imports `url` as the Author, expecting a refusal with `problem`; answers the requests it made. */
async function refused(url: string, problem: string) {
	const before = install.http.requests.length;
	await expect(author.api.media.importUrl({ siteId, url })).rejects.toMatchObject({
		code: "MEDIA_IMPORT_REFUSED",
		data: { problem },
	});
	return install.http.requests.slice(before);
}

describe("Import from URL", () => {
	test("fetches a file from a public address, pinned to the address checked, and treats it as an upload", async () => {
		install.http.respond("GET", "https://photos.example/bakes/Sourdough%20Loaf.jpg", {
			body: image,
			headers: { "content-type": "image/jpeg" },
		});
		const before = install.http.requests.length;

		const { media } = await author.api.media.importUrl({
			siteId,
			url: "https://photos.example/bakes/Sourdough%20Loaf.jpg",
		});

		expect(media).toMatchObject({ kind: "image", status: "processing", fileName: "Sourdough Loaf.jpg", canEdit: true });
		expect(install.http.requests.slice(before).map((call) => [call.url, call.address])).toEqual([
			["https://photos.example/bakes/Sourdough%20Loaf.jpg", PUBLIC],
		]);
		expect((await install.drainJobs()).failed).toEqual([]);
		const ready = (await author.api.media.get({ siteId, mediaId: media.id })).media;
		expect(ready).toMatchObject({ status: "ready", width: 400, height: 300 });
		expect(ready.url).toMatch(/-sourdough-loaf\.jpg$/);

		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((line) => line.action === "media.import")).toMatchObject({
			details: { mediaId: media.id, fileName: "Sourdough Loaf.jpg", host: "photos.example" },
		});
	});

	test("follows a redirect to another public host, checking and pinning it too", async () => {
		install.http.respond("GET", "https://photos.example/moved.jpg", {
			status: 302,
			headers: { location: "https://cdn.example/files/croissant.jpg" },
		});
		install.http.respond("GET", "https://cdn.example/files/croissant.jpg", { body: image });
		const before = install.http.requests.length;

		const { media } = await author.api.media.importUrl({ siteId, url: "https://photos.example/moved.jpg" });

		expect(media.fileName).toBe("croissant.jpg");
		expect(install.http.requests.slice(before).map((call) => call.address)).toEqual([PUBLIC, OTHER_PUBLIC]);
	});

	test("refuses addresses inside a network, written as addresses", async () => {
		for (const url of [
			"http://127.0.0.1/a.jpg",
			"http://[::1]/a.jpg",
			"http://10.1.2.3/a.jpg",
			"http://172.16.0.9/a.jpg",
			"http://192.168.1.20/a.jpg",
			"http://169.254.169.254/latest/meta-data/",
			"http://[fe80::1]/a.jpg",
			"http://[fc00::5]/a.jpg",
			"http://100.64.0.1/a.jpg",
			"http://0.0.0.0/a.jpg",
			"http://224.0.0.1/a.jpg",
			"http://[::ffff:127.0.0.1]/a.jpg",
		]) {
			expect(await refused(url, "address")).toEqual([]);
		}
	});

	test("refuses a host whose DNS answer is inside a network (loopback, private, link-local, shared)", async () => {
		const answers: Record<string, string[]> = {
			"loopback.example": ["127.0.0.1"],
			"private.example": ["10.0.0.7"],
			"mixed.example": [PUBLIC, "192.168.0.4"],
			"metadata.example": ["169.254.169.254"],
			"carrier.example": ["100.100.0.1"],
			"v6-local.example": ["fe80::abcd"],
		};
		for (const [host, addresses] of Object.entries(answers)) {
			install.dns.answer(host, addresses);
			install.http.respond("GET", `https://${host}/a.jpg`, { body: image });
			expect(await refused(`https://${host}/a.jpg`, "address")).toEqual([]);
		}
		expect(await refused("https://nowhere.example/a.jpg", "address")).toEqual([]);
	});

	test("refuses a redirect to an address inside a network, after the redirect", async () => {
		install.http.respond("GET", "https://photos.example/to-metadata", {
			status: 301,
			headers: { location: "http://169.254.169.254/latest/meta-data/iam" },
		});
		expect((await refused("https://photos.example/to-metadata", "address")).map((call) => call.url)).toEqual([
			"https://photos.example/to-metadata",
		]);

		install.dns.answer("internal.example", ["10.20.30.40"]);
		install.http.respond("GET", "https://photos.example/to-internal", {
			status: 307,
			headers: { location: "https://internal.example/secret.jpg" },
		});
		expect((await refused("https://photos.example/to-internal", "address")).map((call) => call.url)).toEqual([
			"https://photos.example/to-internal",
		]);
	});

	test("refuses more than 3 redirects", async () => {
		for (const hop of [1, 2, 3, 4]) {
			install.http.respond("GET", `https://photos.example/hop${hop}`, {
				status: 302,
				headers: { location: `/hop${hop + 1}` },
			});
		}
		install.http.respond("GET", "https://photos.example/hop5", { body: image });
		const calls = await refused("https://photos.example/hop1", "redirects");
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/hop1", "/hop2", "/hop3", "/hop4"]);
	});

	test("refuses a file larger than the Install's largest file, whether or not it says its size", async () => {
		const admin = await install.superadmin();
		await admin.api.install.media.update({ maxFileBytes: 1024 * 1024 });
		try {
			const big = new Uint8Array(1024 * 1024 + 1);
			big.set(image.subarray(0, 64));
			install.http.respond("GET", "https://photos.example/big.jpg", {
				body: big,
				headers: { "content-length": String(big.length) },
			});
			await refused("https://photos.example/big.jpg", "size");

			// No length given: it stops being read once it passes the limit.
			install.http.respond("GET", "https://photos.example/unsized.jpg", { body: big });
			await refused("https://photos.example/unsized.jpg", "size");
		} finally {
			await admin.api.install.media.update({ maxFileBytes: 50 * 1024 * 1024 });
		}
	});

	test("refuses an answer that is too slow", async () => {
		install.http.respond("GET", "https://photos.example/slow.jpg", () => new Promise(() => {}));
		const started = performance.now();
		await refused("https://photos.example/slow.jpg", "timeout");
		expect(performance.now() - started).toBeLessThan(IMPORT_TIMEOUT_MS + 5000);
	});

	test("connects to the address it checked, even when DNS answers otherwise afterwards (rebinding)", async () => {
		install.dns.answerInTurn("rebind.example", [[PUBLIC], ["127.0.0.1"]]);
		install.http.respond("GET", "https://rebind.example/a.jpg", { body: image });
		const before = install.http.requests.length;

		await author.api.media.importUrl({ siteId, url: "https://rebind.example/a.jpg" });

		expect(install.http.requests.slice(before).map((call) => call.address)).toEqual([PUBLIC]);
	});

	test("refuses what isn't an http(s) address, an error answer, and what isn't a file the library takes", async () => {
		for (const url of [
			"ftp://photos.example/a.jpg",
			"file:///etc/passwd",
			"https://user:secret@photos.example/a.jpg",
		]) {
			await refused(url, "scheme");
		}
		install.http.respond("GET", "https://photos.example/missing.jpg", { status: 404, body: "Not Found" });
		await expect(
			author.api.media.importUrl({ siteId, url: "https://photos.example/missing.jpg" }),
		).rejects.toMatchObject({ code: "MEDIA_IMPORT_REFUSED", data: { problem: "status", status: 404 } });

		install.http.respond("GET", "https://photos.example/page.jpg", { body: "<!doctype html><title>Hi</title>" });
		await expect(author.api.media.importUrl({ siteId, url: "https://photos.example/page.jpg" })).rejects.toMatchObject({
			code: "MEDIA_TYPE_REFUSED",
		});
	});
});
