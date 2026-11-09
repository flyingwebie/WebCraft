// The builder's canvas is an iframe on the admin host: an empty page the builder fills with the
// rendered tree and the Draft stylesheet. Its own policy runs no script at all (the Site's scripts
// never load there), lets only the admin frame it, and loads images and fonts as Site pages may.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectNoInlineCode } from "../harness/site-safety.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

test("is an empty page that runs no script and only the admin may frame", async () => {
	const response = await install.request(install.adminUrl("/api/builder/canvas"));

	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
	const policy = response.headers.get("content-security-policy") ?? "";
	expect(policy.split("; ")).toEqual(
		expect.arrayContaining([
			"default-src 'none'",
			"img-src 'self' data: https:",
			"media-src 'self' https:",
			"style-src 'self'",
			"frame-ancestors 'self'",
			"base-uri 'none'",
			"form-action 'none'",
		]),
	);
	expect(policy).not.toContain("script-src");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	const html = await response.text();
	expect(html).toBe(
		'<!doctype html><html><head><meta charset="utf-8"><title>Canvas</title></head><body></body></html>',
	);
	expectNoInlineCode(html);
});

test("answers only GET and HEAD, and only on the admin host", async () => {
	expect((await install.request(install.adminUrl("/api/builder/canvas"), { method: "POST" })).status).toBe(405);
	expect((await install.request("https://bakery.sites.test/api/builder/canvas")).status).toBe(404);
});
