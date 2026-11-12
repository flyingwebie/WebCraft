// How much of a request's body the web process reads. Every request comes under one ceiling, so no
// route reads a body without end; the posts anyone may send (the OAuth endpoints, a visitor's choice
// on the Consent banner, a staging password) stop at their own small limits. A client that doesn't
// say how long its body is (chunked transfer encoding) is stopped by reading: these tests check how
// much of the body the web process took, not only what it answered.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { chunkedBody, chunkedPost } from "../harness/bodies.ts";
import { createTestInstall, fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

const MB = 1024 * 1024;

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
/** What the stand-in for the admin's pages read of each request it was handed. */
const pagesRead: number[] = [];

beforeAll(async () => {
	install = await createTestInstall({
		// The admin's pages, standing in for a route that reads whatever body it is sent.
		adminApp: async (request) => {
			const bytes = await request.arrayBuffer();
			pagesRead.push(bytes.byteLength);
			return new Response("a page");
		},
	});
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

let addresses = 0;
const visitor = (request: Request) => install.request(fromAddress(request, `198.51.100.${++addresses}`));

describe("the OAuth endpoints, which anyone may post to", () => {
	for (const [path, type] of [
		["/oauth/register", "application/json"],
		["/oauth/token", "application/x-www-form-urlencoded"],
		["/oauth/revoke", "application/x-www-form-urlencoded"],
		["/oauth/device_authorization", "application/x-www-form-urlencoded"],
	] as const) {
		test(`${path} stops reading a body that doesn't say its length at 64 KiB`, async () => {
			const sent = chunkedBody(4 * MB);

			const answer = await visitor(chunkedPost(install.adminUrl(path), { "content-type": type }, sent.body));

			expect(answer.status).toBe(413);
			expect(await answer.json()).toEqual({ error: "invalid_request", error_description: "The request is too large." });
			expect(sent.taken()).toBeLessThan(128 * 1024);
		});
	}

	test("a body within the limit is still read whole when it comes in chunks", async () => {
		const metadata = JSON.stringify({ client_name: "Notes", redirect_uris: ["https://notes.example/callback"] });
		const body = new Blob([metadata]).stream();

		const answer = await visitor(
			chunkedPost(install.adminUrl("/oauth/register"), { "content-type": "application/json" }, body),
		);

		expect(answer.status).toBe(201);
		expect(await answer.json()).toMatchObject({ client_name: "Notes" });
	});
});

describe("a visitor's choice on the Consent banner", () => {
	test("stops reading a body that doesn't say its length at its limit", async () => {
		const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug: "limits-consent" });
		const origin = await goLive(install, siteId);
		const sent = chunkedBody(4 * MB);

		const answer = await visitor(
			chunkedPost(
				`${origin}/_wc/consent`,
				{ "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
				sent.body,
			),
		);

		expect(answer.status).toBe(413);
		expect(sent.taken()).toBeLessThan(64 * 1024);
	});
});

describe("a staging password", () => {
	test("stops reading a body that doesn't say its length at its limit", async () => {
		const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug: "limits-staging" });
		await staff.api.staging.setPassword({ siteId, password: "crusty sourdough" });
		const origin = "https://limits-staging.sites.test";
		const sent = chunkedBody(4 * MB);

		const answer = await visitor(
			chunkedPost(
				`${origin}/_webcraft/staging/password`,
				{ "content-type": "application/x-www-form-urlencoded", origin, "sec-fetch-site": "same-origin" },
				sent.body,
			),
		);

		expect(answer.status).toBe(413);
		expect(sent.taken()).toBeLessThan(64 * 1024);
	});
});

describe("a route that reads whatever it is sent", () => {
	test("is stopped at the ceiling every request comes under, and answered 413", async () => {
		pagesRead.length = 0;
		const sent = chunkedBody(8 * MB);

		const answer = await visitor(chunkedPost(install.adminUrl("/workspaces"), {}, sent.body));

		expect(answer.status).toBe(413);
		expect(await answer.text()).toBe("Payload Too Large");
		// The admin's own headers, as on every answer of the admin host.
		expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
		expect(pagesRead).toEqual([]);
		expect(sent.taken()).toBeLessThan(2 * MB);
	});

	test("a body that says it is larger than the ceiling isn't read at all", async () => {
		pagesRead.length = 0;
		const sent = chunkedBody(8 * MB);

		const answer = await visitor(
			chunkedPost(install.adminUrl("/workspaces"), { "content-length": String(8 * MB) }, sent.body),
		);

		expect(answer.status).toBe(413);
		expect(pagesRead).toEqual([]);
		expect(sent.taken()).toBe(0);
	});

	test("a body under the ceiling reaches it whole", async () => {
		pagesRead.length = 0;
		const sent = chunkedBody(300 * 1024);

		const answer = await visitor(chunkedPost(install.adminUrl("/workspaces"), {}, sent.body));

		expect(answer.status).toBe(200);
		expect(pagesRead).toEqual([300 * 1024]);
	});

	test("on a Site's hostname too", async () => {
		const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug: "limits-edit" });
		const origin = await goLive(install, siteId);
		const sent = chunkedBody(8 * MB);

		// A page takes no body: nothing of it is read.
		const answer = await visitor(chunkedPost(`${origin}/`, {}, sent.body));

		expect(answer.status).toBe(405);
		expect(sent.taken()).toBe(0);
	});
});

describe("an upload to the Management API", () => {
	test("from nobody signed in is refused before its body is read", async () => {
		const sent = chunkedBody(8 * MB);

		const answer = await visitor(
			chunkedPost(
				install.adminUrl("/api/rpc/media/upload"),
				{ "content-type": "multipart/form-data; boundary=----upload" },
				sent.body,
			),
		);

		expect(answer.status).toBe(401);
		expect(await answer.json()).toMatchObject({ json: { code: "UNAUTHORIZED" } });
		expect(sent.taken()).toBe(0);
	});
});
