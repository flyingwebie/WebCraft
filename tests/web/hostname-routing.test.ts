import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

describe("hostname routing", () => {
	test("a hostname that belongs to no Site gets a plain, unbranded 404", async () => {
		const response = await install.request("https://no-such-site.example/about");

		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		const body = await response.text();
		expect(body).toBe("Not Found");
		for (const [name, value] of response.headers) {
			expect(`${name}: ${value}`.toLowerCase()).not.toContain("webcraft");
		}
	});
});
