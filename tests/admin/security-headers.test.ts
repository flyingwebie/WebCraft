// The admin host's security headers (audit A3-2). Sites sit on sibling hostnames of the admin, which
// are same-site with it, so a page there could frame the admin with the person's session, and nothing
// limited what markup injected into an admin page could do. Every answer on the admin host now says
// who may frame it (nobody; the builder's canvas the admin itself), that its type is not to be
// guessed, where addresses may go, that the host is HTTPS only, and carries a policy. Seam 1 has no
// admin app (its pages answer 404 here); the pages' own policy is checked in a browser
// (tests/browser/admin-security-headers.browser.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { expectAdminHeaders, expectInertAnswer } from "../harness/admin-safety.ts";
import { createApiToken } from "../harness/api-tokens.ts";
import { API_PATH, createTestInstall, type TestInstall } from "../harness/index.ts";
import { policyOf } from "../harness/site-safety.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
	await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

describe("every answer on the admin host", () => {
	const answers: [string, string, RequestInit?][] = [
		["a path nothing answers", "/nothing-here"],
		["the health check", "/healthz"],
		["the readiness check", "/readyz"],
		["Caddy's ask", "/caddy/ask?domain=unknown.example"],
		["the Management API refusing a GET", `${API_PATH}/shell/context`],
		["the Management API answering a page's call", `${API_PATH}/shell/context`, { method: "POST" }],
		[
			"the Management API refusing another site's page",
			`${API_PATH}/shell/context`,
			{ method: "POST", headers: { "sec-fetch-site": "cross-site" } },
		],
		["the public API without a token", "/api/v1/sites"],
		["the public API's description", "/api/v1/openapi.json"],
		["the MCP server without a token", "/mcp", { method: "POST", body: "{}" }],
		["the OAuth metadata", "/.well-known/oauth-authorization-server"],
		["a Media preview nobody may see", "/api/media/unknown/file.png"],
		["a Form upload nobody may see", "/api/forms/uploads/unknown/file"],
	];
	for (const [what, path, init] of answers) {
		test(`${what} carries the security headers and a policy that loads nothing`, async () => {
			const response = await install.request(install.adminUrl(path), init);
			expectInertAnswer(response);
		});
	}

	test("the public API answering a token carries them too", async () => {
		const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
		const { secret } = await createApiToken(await install.superadmin(), { workspaceId, name: "Headers" });
		const response = await install.request(install.adminUrl("/api/v1/sites/list"), {
			method: "POST",
			headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
			body: JSON.stringify({ workspaceId }),
		});
		expect(response.status).toBe(200);
		expectInertAnswer(response);
	});
});

describe("an answer that brings its own policy", () => {
	test("the builder's canvas keeps it: only the admin's own pages frame it", async () => {
		const response = await install.request(install.adminUrl("/api/builder/canvas"));
		expect(response.status).toBe(200);
		const policy = expectAdminHeaders(response);
		expect(policy.get("frame-ancestors")).toEqual(["'self'"]);
		expect(policy.get("default-src")).toEqual(["'none'"]);
		expect(policy.has("script-src")).toBe(false);
		expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	});
});

describe("an unexpected failure", () => {
	test("is answered 500 with the same headers", async () => {
		const broken = await createTestInstall({ database: "unreachable" });
		try {
			// Caddy's ask reads the domain's row: without a database it fails.
			const response = await broken.request(broken.adminUrl("/caddy/ask?domain=shop.example"));
			expect(response.status).toBe(500);
			expect(await response.text()).toBe("Internal Server Error");
			expectInertAnswer(response);
		} finally {
			await broken.close();
		}
	});
});

describe("a Site's hostname", () => {
	test("gets none of the admin's headers: the Site side has its own", async () => {
		const response = await install.request("https://unknown.sites.test/healthz");
		expect(response.headers.get("strict-transport-security")).toBeNull();
		expect(policyOf(response).has("default-src")).toBe(false);
	});
});
