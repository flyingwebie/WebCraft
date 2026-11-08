import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
