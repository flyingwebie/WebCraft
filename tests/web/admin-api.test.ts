import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { API_PATH, createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

describe("the Management API at /api/rpc", () => {
	test("changes nothing on a GET, even with a session cookie", async () => {
		const browser = await install.signIn(superadmin);
		const query = new URLSearchParams({ data: JSON.stringify({ json: {} }) });

		const response = await browser.request(install.adminUrl(`${API_PATH}/install/masterKey/confirmStored?${query}`));

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
		expect((await browser.api.shell.context()).banners.masterKey).toBe(true);
	});

	test("refuses requests from another site's pages, even with the person's cookie", async () => {
		const browser = await install.signIn(superadmin);
		const cookie = Array.from(browser.cookies, ([name, value]) => `${name}=${value}`).join("; ");

		const response = await install.request(install.adminUrl(`${API_PATH}/install/masterKey/confirmStored`), {
			method: "POST",
			headers: { "content-type": "application/json", cookie, "sec-fetch-site": "cross-site" },
			body: JSON.stringify({ json: {} }),
		});

		expect(response.status).toBe(403);
		expect((await browser.api.shell.context()).banners.masterKey).toBe(true);
	});

	/** Confirms the Master key is stored, signed in as the Superadmin, with `headers`; answers the status. */
	async function confirmStored(headers: Record<string, string>) {
		const browser = await install.signIn(superadmin);
		const cookie = Array.from(browser.cookies, ([name, value]) => `${name}=${value}`).join("; ");
		const response = await install.request(install.adminUrl(`${API_PATH}/install/masterKey/confirmStored`), {
			method: "POST",
			headers: { "content-type": "application/json", cookie, ...headers },
			body: JSON.stringify({ json: {} }),
		});
		return { status: response.status, banner: (await browser.api.shell.context()).banners.masterKey };
	}

	test("refuses a page whose Origin isn't the admin's own, whatever the browser says of the site", async () => {
		const admin = new URL(install.adminUrl("/"));
		const otherPort = `${admin.protocol}//${admin.hostname}:${Number(admin.port || 443) + 1}`;
		for (const headers of [
			{ origin: "https://attacker.example" },
			{ origin: otherPort },
			{ origin: otherPort, "sec-fetch-site": "same-origin" },
			{ origin: "null" },
			{ "sec-fetch-site": "same-site" },
		]) {
			expect({ headers, ...(await confirmStored(headers)) }).toEqual({ headers, status: 403, banner: true });
		}
	});

	test("takes the admin's own pages, and callers that aren't browsers", async () => {
		expect(
			(await confirmStored({ origin: new URL(install.adminUrl("/")).origin, "sec-fetch-site": "same-origin" })).status,
		).toBe(200);
		expect((await confirmStored({})).status).toBe(200);
	});

	test("API tokens never use it: the public API takes them whatever page sent the request", async () => {
		const browser = await install.signIn(superadmin);
		const workspaceId = (await install.createWorkspace()).id;
		const { secret } = await createApiToken(browser, { workspaceId, name: "Deploy" });

		const response = await tokenClient(install, secret).request("sites/list", {
			headers: {
				"content-type": "application/json",
				origin: "https://attacker.example",
				"sec-fetch-site": "cross-site",
			},
			body: JSON.stringify({ workspaceId }),
		});

		expect(response.status).toBe(200);
	});

	test("answers are never cached", async () => {
		const response = await install.request(install.adminUrl(`${API_PATH}/setup/state`), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ json: {} }),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	test("a path that is no procedure is a 404", async () => {
		const response = await install.request(install.adminUrl(`${API_PATH}/no/such/procedure`), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ json: {} }),
		});

		expect(response.status).toBe(404);
	});
});

describe("when the database can't be reached", () => {
	let unreachable: TestInstall;

	beforeAll(async () => {
		unreachable = await createTestInstall({ database: "unreachable" });
	});

	afterAll(async () => {
		await unreachable.close();
	});

	test("a call fails with a 500 that explains nothing, and the failure is logged", async () => {
		const browser = unreachable.browser();

		await expect(browser.api.setup.state()).rejects.toMatchObject({
			status: 500,
			code: "INTERNAL_SERVER_ERROR",
			message: "Internal server error",
		});
		expect(unreachable.logs).toContainEqual(
			expect.objectContaining({
				level: "error",
				msg: "A Management API call failed unexpectedly",
				procedure: "setup.state",
			}),
		);
	});
});
