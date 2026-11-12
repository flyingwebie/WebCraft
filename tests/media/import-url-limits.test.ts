// How many Imports from URL run at once (audit A4-4): each one holds its whole file in the web
// process's memory while it is fetched, so a person, and a Site, may start only so many within the
// time one import can take. Past that they are refused before anything is fetched. An Import's own
// files (the worker's) are not a person's Imports from URL and are never counted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MEDIA_IMPORT_LIMITS } from "@webcraft/core";
import { photo } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csvSettings, importCsv } from "../imports/support.ts";

/** How long the test Install waits for an import (the real wait is 30 seconds). */
const IMPORT_TIMEOUT_MS = 400;
const SLOW = /^https:\/\/slow\.example\//;

let install: TestInstall;
let workspaceId: string;
let image: Uint8Array;

beforeAll(async () => {
	install = await createTestInstall({ mediaImportTimeoutMs: IMPORT_TIMEOUT_MS });
	workspaceId = (await install.createWorkspace()).id;
	image = await photo({ width: 40, height: 30 });
	install.dns.answer("slow.example", ["93.184.216.34"]);
	install.dns.answer("photos.example", ["93.184.216.35"]);
	// A server that takes the connection and never sends the file.
	install.http.respond("GET", SLOW, () => new Promise(() => {}));
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

async function newSite(): Promise<string> {
	return (await install.createSite(workspaceId, { slug: `limits-${++sites}` })).id;
}

async function newAuthor(): Promise<TestBrowser> {
	return (await install.createMember({ workspaceId, role: "author" })).browser;
}

/** Starts `count` imports from the slow server at once; answers each one's error code, in order. */
async function importAtOnce(person: TestBrowser, siteId: string, count: number): Promise<(string | undefined)[]> {
	const started = Array.from({ length: count }, (_, number) =>
		person.api.media.importUrl({ siteId, url: `https://slow.example/${siteId}/${crypto.randomUUID()}/${number}.mp4` }),
	);
	return (await Promise.allSettled(started)).map((result) =>
		result.status === "fulfilled" ? "imported" : (result.reason as { code?: string }).code,
	);
}

const slowCalls = (siteId: string) =>
	install.http.requests.filter((request) => request.url.startsWith(`https://slow.example/${siteId}/`));

describe("Imports from URL at once", () => {
	test("one person's are held to the limit: the rest are refused before anything is fetched", async () => {
		const siteId = await newSite();
		const author = await newAuthor();
		const { limit, windowMs } = MEDIA_IMPORT_LIMITS.person;

		const answers = await importAtOnce(author, siteId, 40);

		expect(answers.filter((code) => code === "MEDIA_IMPORT_REFUSED")).toHaveLength(limit);
		expect(answers.filter((code) => code === "TOO_MANY_REQUESTS")).toHaveLength(40 - limit);
		expect(slowCalls(siteId)).toHaveLength(limit);

		// The refusal says when to try again, and by then it works.
		const refused = await author.api.media
			.importUrl({ siteId, url: "https://photos.example/later.jpg" })
			.catch((error: unknown) => error);
		expect(refused).toMatchObject({
			code: "TOO_MANY_REQUESTS",
			status: 429,
			data: { retryAfterSeconds: windowMs / 1000 },
		});
		install.http.respond("GET", "https://photos.example/later.jpg", { body: image });
		await install.clock.advance(windowMs);
		const { media } = await author.api.media.importUrl({ siteId, url: "https://photos.example/later.jpg" });
		expect(media.fileName).toBe("later.jpg");
	});

	test("the person's limit follows them to another Site", async () => {
		const author = await newAuthor();
		const first = await newSite();
		const second = await newSite();
		const { limit } = MEDIA_IMPORT_LIMITS.person;

		expect(await importAtOnce(author, first, limit)).toEqual(Array(limit).fill("MEDIA_IMPORT_REFUSED"));
		expect(await importAtOnce(author, second, 3)).toEqual(Array(3).fill("TOO_MANY_REQUESTS"));
		expect(slowCalls(second)).toEqual([]);
	});

	test("a Site's are held to its own limit, whoever starts them", async () => {
		const siteId = await newSite();
		const perPerson = MEDIA_IMPORT_LIMITS.person.limit;
		const people = Math.ceil(MEDIA_IMPORT_LIMITS.site.limit / perPerson) + 1;
		const authors = await Promise.all(Array.from({ length: people }, () => newAuthor()));

		const answers = (await Promise.all(authors.map((author) => importAtOnce(author, siteId, perPerson)))).flat();

		expect(answers.filter((code) => code === "MEDIA_IMPORT_REFUSED")).toHaveLength(MEDIA_IMPORT_LIMITS.site.limit);
		expect(answers.filter((code) => code === "TOO_MANY_REQUESTS")).toHaveLength(
			people * perPerson - MEDIA_IMPORT_LIMITS.site.limit,
		);
		expect(slowCalls(siteId)).toHaveLength(MEDIA_IMPORT_LIMITS.site.limit);

		// Another Site of the Workspace is not held up by it.
		const elsewhere = await newSite();
		install.http.respond("GET", "https://photos.example/elsewhere.jpg", { body: image });
		const other = await newAuthor();
		const { media } = await other.api.media.importUrl({
			siteId: elsewhere,
			url: "https://photos.example/elsewhere.jpg",
		});
		expect(media.fileName).toBe("elsewhere.jpg");
	});

	test("an Import's files are not counted: more of them than a person's limit all come in", async () => {
		const siteId = await newSite();
		const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Products",
			urlPattern: "/products/{slug}",
			fields: [{ key: "photo", label: "Photo", type: "media" }],
		});
		const files = MEDIA_IMPORT_LIMITS.site.limit + 2;
		const rows = Array.from({ length: files }, (_, number) => {
			install.http.respond("GET", `https://photos.example/csv/${siteId}/${number}.jpg`, { body: image });
			return `Loaf ${number},https://photos.example/csv/${siteId}/${number}.jpg`;
		});

		const { run } = await importCsv(
			install,
			staff.api,
			siteId,
			csvSettings(postType.id, [
				{ column: "title", to: "title" },
				{ column: "photo", to: "fields.photo" },
			]),
			`title,photo\n${rows.join("\n")}\n`,
		);

		expect(run).toMatchObject({ status: "done", files, counts: { created: files, problemRows: 0 } });
		// And the person who ran it may still import by hand.
		install.http.respond("GET", "https://photos.example/by-hand.jpg", { body: image });
		const { media } = await staff.api.media.importUrl({ siteId, url: "https://photos.example/by-hand.jpg" });
		expect(media.fileName).toBe("by-hand.jpg");
	});
});
