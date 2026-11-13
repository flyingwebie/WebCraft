import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

describe("on a migrated database", () => {
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall();
	});

	afterAll(async () => {
		await install.close();
	});

	test("/healthz on the admin host says the web process is alive", async () => {
		const response = await install.request(install.adminUrl("/healthz"));

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ status: "ok" });
	});

	test("/readyz on the admin host says the Install is ready", async () => {
		const response = await install.request(install.adminUrl("/readyz"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ready", checks: { database: "ok", schema: "current" } });
	});

	test("the admin hostname matches whatever its letter case", async () => {
		const response = await install.request("https://ADMIN.Test/healthz");

		expect(response.status).toBe(200);
	});

	test("HEAD /healthz answers without a body", async () => {
		const response = await install.request(install.adminUrl("/healthz"), { method: "HEAD" });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("");
	});

	test("the health checks only answer GET and HEAD", async () => {
		const response = await install.request(install.adminUrl("/readyz"), { method: "POST" });

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET, HEAD");
	});

	test("on a Site hostname, /healthz and /readyz are not health checks", async () => {
		for (const path of ["/healthz", "/readyz"]) {
			const response = await install.request(`https://shop.example${path}`);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		}
	});
});

describe("on a database nobody has migrated", () => {
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall({ database: "empty" });
	});

	afterAll(async () => {
		await install.close();
	});

	test("/readyz answers 503: the schema is behind", async () => {
		const response = await install.request(install.adminUrl("/readyz"));

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "not ready", checks: { database: "ok", schema: "behind" } });
	});

	test("/healthz still answers: the process itself is alive", async () => {
		const response = await install.request(install.adminUrl("/healthz"));

		expect(response.status).toBe(200);
	});
});

describe("when the database can't be reached", () => {
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall({ database: "unreachable" });
	});

	afterAll(async () => {
		await install.close();
	});

	test("/readyz answers 503: the database is unreachable", async () => {
		const response = await install.request(install.adminUrl("/readyz"));

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			status: "not ready",
			checks: { database: "unreachable", schema: "unknown" },
		});
	});
});

describe("on Railway (WEBCRAFT_EDGE=railway)", () => {
	// Railway checks a new deployment before sending it traffic, always with this hostname.
	const RAILWAY_CHECK = "https://healthcheck.railway.app";
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall({ edge: "railway" });
	});

	afterAll(async () => {
		await install.close();
	});

	test("/healthz and /readyz also answer on the hostname Railway's health checks use", async () => {
		const alive = await install.request(`${RAILWAY_CHECK}/healthz`);
		expect(alive.status).toBe(200);
		expect(await alive.json()).toEqual({ status: "ok" });

		const ready = await install.request(`${RAILWAY_CHECK}/readyz`);
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: "ready", checks: { database: "ok", schema: "current" } });
	});

	test("nothing else answers there: no admin, no Site", async () => {
		for (const path of ["/", "/api/rpc/session/current", "/caddy/ask?domain=admin.test"]) {
			const response = await install.request(`${RAILWAY_CHECK}${path}`);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		}
	});

	test("on any other edge, that hostname is no Site's like any other", async () => {
		const caddy = await createTestInstall();
		try {
			const response = await caddy.request(`${RAILWAY_CHECK}/readyz`);

			expect(response.status).toBe(404);
		} finally {
			await caddy.close();
		}
	});
});
