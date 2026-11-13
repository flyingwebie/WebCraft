// The web server's own body limit, on the server the production web process starts (`serveWeb`, as
// `serve.ts` does), in front of a test Install's handler on a port of this computer: requests come
// over real HTTP, so the server's limit and the handler's ceiling both apply, as in production.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serveWeb } from "@webcraft/server/serving";

import { createApiToken } from "../harness/api-tokens.ts";
import { chunkedBody } from "../harness/bodies.ts";
import { pdf } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

const MB = 1024 * 1024;

let install: TestInstall;
let server: ReturnType<typeof serveWeb>;

beforeAll(async () => {
	install = await createTestInstall();
	const web = install.webProcess();
	server = serveWeb({ fetch: web.request, upgrade: web.upgrade }, { port: 0, hostname: "127.0.0.1" });
});

afterAll(async () => {
	await server.stop(true);
	await install.close();
});

/** A request to the server over HTTP, for the admin host. */
function send(path: string, init: RequestInit & { duplex?: "half" }): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("host", install.adminHost);
	return fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers });
}

describe("the web server's own body limit", () => {
	test("lets a file over 128 MB through once the Install takes files that large", async () => {
		const admin = await install.superadmin();
		const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
		const siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "large-files" })).id;
		await admin.api.install.media.update({ maxFileBytes: 200 * MB });
		const { secret } = await createApiToken(admin, { workspaceId, name: "Uploader" });
		const bytes = new Uint8Array(130 * MB);
		bytes.set(pdf("a long guide"));
		const form = new FormData();
		form.append("siteId", siteId);
		form.append("file", new File([bytes], "guide.pdf", { type: "application/pdf" }));

		const answer = await send("/api/v1/media/upload", {
			method: "POST",
			headers: { authorization: `Bearer ${secret}` },
			body: form,
		});

		expect(answer.status).toBe(200);
		expect(await answer.json()).toMatchObject({ media: { fileName: "guide.pdf", sizeBytes: 130 * MB } });
	}, 120_000);

	test("a larger file than the Install takes is still refused as too large, by the Management API", async () => {
		const admin = await install.superadmin();
		const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
		const siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "too-large" })).id;
		await admin.api.install.media.update({ maxFileBytes: 140 * MB });
		const { secret } = await createApiToken(admin, { workspaceId, name: "Uploader" });
		const form = new FormData();
		form.append("siteId", siteId);
		form.append("file", new File([new Uint8Array(150 * MB)], "guide.pdf", { type: "application/pdf" }));

		const answer = await send("/api/v1/media/upload", {
			method: "POST",
			headers: { authorization: `Bearer ${secret}` },
			body: form,
		});

		expect(answer.status).toBe(413);
		expect(await answer.json()).toMatchObject({ json: { code: "MEDIA_TOO_LARGE", data: { maxBytes: 140 * MB } } });
	}, 120_000);

	test("doesn't widen what anyone may post: an anonymous body stops at its route's limit", async () => {
		const sent = chunkedBody(200 * MB, 64 * 1024);

		const answer = await send("/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: sent.body,
			duplex: "half",
		});

		expect(answer.status).toBe(413);
		expect(await answer.json()).toEqual({ error: "invalid_request", error_description: "The request is too large." });
		// The route reads 64 KiB; the rest is what the connection's buffers held when it stopped.
		expect(sent.taken()).toBeLessThan(16 * MB);
	}, 120_000);

	test("nor an upload from nobody signed in, which is refused without being read", async () => {
		const sent = chunkedBody(200 * MB, 64 * 1024);

		const answer = await send("/api/rpc/media/upload", {
			method: "POST",
			headers: { "content-type": "multipart/form-data; boundary=----upload" },
			body: sent.body,
			duplex: "half",
		});

		expect(answer.status).toBe(401);
		expect(sent.taken()).toBeLessThan(16 * MB);
	}, 120_000);
});
