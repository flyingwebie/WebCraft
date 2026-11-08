// The sample seam-1 test: it uses the in-process request helper, the job drain, the fake outgoing
// HTTP, the test clock and the log. Copy its shape. (tests/email/ shows the fake mailer.)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { samplePing } from "@webcraft/core";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

const MINUTE = 60_000;

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-02T09:00:00.000Z") });
});

afterAll(async () => {
	await install.close();
});

beforeEach(() => {
	install.http.reset();
});

/** What the sample job logged, oldest first. */
function pings() {
	return install.logs
		.filter((entry) => entry.msg === "Pinged a URL")
		.map(({ url, status, checkedAt }) => ({ url, status, checkedAt }));
}

describe("the sample job", () => {
	test("asks a URL for its status and logs the answer, timed by the clock", async () => {
		const health = await install.request(install.adminUrl("/healthz"));
		expect(health.status).toBe(200);

		install.http.respond("GET", "https://status.example.org/ping", { status: 204 });
		await install.clock.advance(90 * MINUTE);
		await install.jobs.send(samplePing, { url: "https://status.example.org/ping" });
		expect(pings()).toEqual([]);

		const report = await install.drainJobs();

		expect(report.failed).toEqual([]);
		expect(report.completed.map((run) => run.name)).toEqual(["sample.ping"]);
		expect(install.http.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			"GET https://status.example.org/ping",
		]);
		expect(pings()).toEqual([
			{ url: "https://status.example.org/ping", status: 204, checkedAt: "2026-03-02T10:30:00.000Z" },
		]);
	});

	test("a job sent to start later runs only once the clock reaches that time", async () => {
		install.http.respond("GET", /^https:\/\/status\.example\.org\//, { body: "ok" });
		const inAnHour = new Date(install.clock.now().getTime() + 60 * MINUTE);
		await install.jobs.send(samplePing, { url: "https://status.example.org/later" }, { startAfter: inAnHour });

		expect((await install.drainJobs()).completed).toEqual([]);

		await install.clock.advance(60 * MINUTE);

		expect((await install.drainJobs()).completed).toHaveLength(1);
		expect(pings().at(-1)).toMatchObject({ url: "https://status.example.org/later", status: 200 });
	});

	test("a failed job is retried a minute later", async () => {
		await install.jobs.send(samplePing, { url: "https://flaky.example.org/" });
		const before = pings().length;

		const first = await install.drainJobs();

		expect(first.completed).toEqual([]);
		expect(first.failed.map((run) => run.error?.message)).toEqual([
			"No fake answer for GET https://flaky.example.org/. Prepare one with install.http.respond().",
		]);
		expect(pings()).toHaveLength(before);

		install.http.respond("GET", "https://flaky.example.org/", { body: "back" });
		await install.clock.advance(MINUTE);
		const retry = await install.drainJobs();

		expect(retry.completed).toHaveLength(1);
		expect(pings().at(-1)).toMatchObject({ url: "https://flaky.example.org/", status: 200 });
	});
});
