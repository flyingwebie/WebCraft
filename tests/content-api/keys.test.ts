// Switching the Content API on and Content keys (ADR 0029, GLOSSARY.md › Content API, Content key):
// off by default; once Staff switch it on, every request needs a Content key of that Site, sent in
// the `Authorization` header (never the query string); keys are named, shown once, revocable, and
// count their use.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { contentClient } from "./support.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;
let siteId: string;
let origin: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	origin = await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("switching it on", () => {
	test("a Site's Content API is off until Staff switch it on: every path answers 404 CONTENT_API_OFF as JSON", async () => {
		const frontend = contentClient(install, origin, null);

		const { response, body } = await frontend.json("/entries/blog");

		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(body).toMatchObject({ code: "CONTENT_API_OFF", status: 404 });
		expect(typeof body.message).toBe("string");
	});

	test("Staff switch it on and make a Content key, shown once; a frontend sending it reads the Site's published Entries", async () => {
		await staff.api.contentApi.update({ siteId, enabled: true });
		const { key, secret } = await staff.api.contentApi.keys.create({ siteId, name: "Shop frontend" });

		expect(secret).toMatch(/^webcraft-ck_[A-Za-z0-9_-]{43}$/);
		expect(key).toMatchObject({ name: "Shop frontend", hint: secret.slice(-4), origins: [], status: "active" });
		expect(JSON.stringify(await staff.api.contentApi.get({ siteId }))).not.toContain(secret);

		const postTypeId = (
			await staff.api.postTypes.create({ siteId, name: "Blog", key: "blog", urlPattern: "/blog/{slug}" })
		).postType.id;
		const { entry } = await staff.api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
		await staff.api.entries.publish({ siteId, entryId: entry.id });

		const { response, body } = await contentClient(install, origin, secret).json<{ items: { title: string }[] }>(
			"/entries/blog",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(body.items.map((item) => item.title)).toEqual(["Fresh bread"]);
	});
});

describe("keys", () => {
	let secret: string;
	beforeAll(async () => {
		await staff.api.contentApi.update({ siteId, enabled: true });
		secret = (await staff.api.contentApi.keys.create({ siteId, name: "App" })).secret;
	});

	test("a request without a key is refused: 401 CONTENT_KEY_INVALID, missing", async () => {
		const { response, body } = await contentClient(install, origin, null).json("/entries/blog");

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe('Bearer realm="content"');
		expect(body).toMatchObject({ code: "CONTENT_KEY_INVALID", data: { problem: "missing" } });
	});

	test("a key the Site doesn't know is refused as unknown, whatever it looks like", async () => {
		for (const sent of ["webcraft-ck_nope", "something else", `${secret}x`]) {
			const { response, body } = await contentClient(install, origin, sent).json("/entries/blog");
			expect(response.status).toBe(401);
			expect(body).toMatchObject({ code: "CONTENT_KEY_INVALID", data: { problem: "unknown" } });
		}
	});

	test("a key in the query string is refused, with or without a header, so logs never keep one", async () => {
		const frontend = contentClient(install, origin, secret);
		for (const query of [`?key=${secret}`, `?access_token=${secret}`]) {
			const { response, body } = await frontend.json(`/entries/blog${query}`);
			expect(response.status).toBe(400);
			expect(body).toMatchObject({ code: "CONTENT_KEY_IN_QUERY" });
		}
	});

	test("a revoked key is refused at once, as revoked; the others keep working", async () => {
		const other = await staff.api.contentApi.keys.create({ siteId, name: "Old app" });
		const frontend = contentClient(install, origin, other.secret);
		expect((await frontend.get("/entries/blog")).status).toBe(200);

		const { key } = await staff.api.contentApi.keys.revoke({ siteId, keyId: other.key.id });

		expect(key.status).toBe("revoked");
		const { response, body } = await frontend.json("/entries/blog");
		expect(response.status).toBe(401);
		expect(body).toMatchObject({ code: "CONTENT_KEY_INVALID", data: { problem: "revoked" } });
		expect((await contentClient(install, origin, secret).get("/entries/blog")).status).toBe(200);
	});

	test("a key never opens another Site's Content API, not even one of the same Workspace", async () => {
		const otherSiteId = (await install.createSite(workspaceId, { name: "Acme Cafe", slug: "cafe" })).id;
		const otherOrigin = await goLive(install, otherSiteId);
		await staff.api.contentApi.update({ siteId: otherSiteId, enabled: true });

		const { response, body } = await contentClient(install, otherOrigin, secret).json("/entries/blog");

		expect(response.status).toBe(401);
		expect(body).toMatchObject({ code: "CONTENT_KEY_INVALID", data: { problem: "unknown" } });
	});

	test("switched off again, the Site's keys stop working until it is on again", async () => {
		const frontend = contentClient(install, origin, secret);
		await staff.api.contentApi.update({ siteId, enabled: false });
		expect((await frontend.json("/entries/blog")).body).toMatchObject({ code: "CONTENT_API_OFF" });

		await staff.api.contentApi.update({ siteId, enabled: true });
		expect((await frontend.get("/entries/blog")).status).toBe(200);
	});
});
