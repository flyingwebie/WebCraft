// The Error log (spec story 17): unexpected failures on the Install, from requests and jobs, grouped by
// cause, each with a count, when it was first and last seen, and the Workspaces and Sites involved.
// Only the Superadmin reads it. Refusals (a wrong input, a missing Permission) aren't failures.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { samplePing } from "@webcraft/core";

import { pdf, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";
import { sample } from "../modules/sample/index.ts";

let install: TestInstall;
let admin: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
});

afterAll(async () => {
	await install.close();
});

const HOUR = 60 * 60_000;

/** The Error log's groups, newest first. */
async function groups() {
	return (await admin.api.errorLog.list({})).groups;
}

describe("failures in jobs", () => {
	test("land in the Error log grouped by cause, counted, with when they were first and last seen", async () => {
		const firstAt = install.clock.now();
		// Nothing answers this address, so the job fails: a failure nothing in the job expected.
		await install.jobs.send(samplePing, { url: "https://status.unreachable.example/a" });
		await install.jobs.send(samplePing, { url: "https://status.unreachable.example/b" });
		expect((await install.drainJobs()).failed).toHaveLength(2);

		const [group, ...others] = await groups();
		expect(others).toEqual([]);
		expect(group).toMatchObject({
			name: "UnexpectedRequestError",
			source: { kind: "job", name: "sample.ping" },
			count: 2,
			firstSeenAt: firstAt,
			lastSeenAt: firstAt,
			resolvedAt: null,
			places: [],
		});
		expect(group?.message).toContain("status.unreachable.example");

		// An hour on, the two are tried again and a third fails the same way: one cause, five times.
		await install.clock.advance(HOUR);
		await install.jobs.send(samplePing, { url: "https://status.unreachable.example/c" });
		await install.drainJobs();

		const [again] = await groups();
		expect(again).toMatchObject({
			id: group?.id,
			count: 5,
			firstSeenAt: firstAt,
			lastSeenAt: install.clock.now(),
		});
	});
});

describe("failures in requests", () => {
	test("land in the Error log with the Workspace and Site involved; the visitor gets a plain 500 with a request id", async () => {
		const workspace = await install.createWorkspace("Acme Ltd");
		const site = await install.createSite(workspace.id, { name: "Acme Bakery", slug: "bakery" });
		const origin = await goLive(install, site.id);
		const { media } = await admin.api.media.upload({ siteId: site.id, file: upload(pdf("Menu"), "menu.pdf") });
		const name = (media.url ?? "").replace("/_media/", "");
		// The Site's media folder can't be read any more: serving its file fails in a way nothing expects.
		const folder = join(install.storageDir, workspace.id, site.id, "media");
		chmodSync(folder, 0o000);
		let answer: Response;
		try {
			answer = await install.request(`${origin}/_media/${name}`);
		} finally {
			chmodSync(folder, 0o755);
		}

		expect(answer.status).toBe(500);
		expect(await answer.text()).toBe("Internal Server Error");
		const requestId = answer.headers.get("x-request-id");
		const failure = (await groups()).find((group) => group.source.kind === "request");
		expect(failure).toMatchObject({
			count: 1,
			source: { kind: "request", name: "GET /_media/" + name },
			requestId,
			places: [
				{ workspace: { id: workspace.id, name: "Acme Ltd" }, site: { id: site.id, name: "Acme Bakery" }, count: 1 },
			],
		});
		expect(failure?.message).toContain("EACCES");
		expect(install.logs.find((entry) => entry.requestId === requestId && entry.level === "error")).toBeDefined();
	});

	test("refusals aren't failures: a wrong input or a missing Permission leaves the Error log as it was", async () => {
		const before = await groups();
		const workspace = await install.createWorkspace();
		const member = await install.createMember({ workspaceId: workspace.id, role: "author" });

		await expect(admin.api.workspaces.create({ name: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(member.browser.api.errorLog.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await install.request(install.adminUrl("/api/rpc/no/such/procedure"), { method: "POST" })).toHaveProperty(
			"status",
			404,
		);

		expect(await groups()).toEqual(before);
	});
});

describe("who reads it", () => {
	test("only the Superadmin: Staff and Members are refused", async () => {
		const workspace = await install.createWorkspace();
		const { browser: staff } = await install.createStaff({ workspaces: "all" });
		const { browser: owner } = await install.createMember({ workspaceId: workspace.id, role: "owner" });

		for (const browser of [staff, owner]) {
			await expect(browser.api.errorLog.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		await expect(install.browser().api.errorLog.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("resolving", () => {
	test("marks a cause resolved, recorded in the Audit log; it opens again when it happens again", async () => {
		await install.jobs.send(samplePing, { url: "https://resolve.unreachable.example/" });
		await install.drainJobs();
		const group = (await groups())[0];
		if (!group) throw new Error("No cause was noted.");

		const { group: resolved } = await admin.api.errorLog.resolve({ groupId: group.id });

		expect(resolved).toMatchObject({
			id: group.id,
			resolvedAt: install.clock.now(),
			resolvedBy: { name: "Sam Superadmin" },
		});
		expect((await groups()).map((open) => open.id)).not.toContain(group.id);
		expect((await admin.api.errorLog.list({ state: "resolved" })).groups.map((done) => done.id)).toContain(group.id);
		const { entries } = await admin.api.audit.list({ action: "errorLog.resolve" });
		expect(entries[0]).toMatchObject({ action: "errorLog.resolve", details: { groupId: group.id } });

		// It happens again (the job's retry, a minute on): open again, saying since when.
		await install.clock.advance(2 * 60_000);
		await install.drainJobs();
		const [reopened] = (await groups()).filter((open) => open.id === group.id);
		expect(reopened).toMatchObject({ resolvedAt: null, resolvedBy: null, reopenedAt: install.clock.now() });
	});

	test("a cause that isn't there any more is refused", async () => {
		await expect(admin.api.errorLog.resolve({ groupId: crypto.randomUUID() })).rejects.toMatchObject({
			code: "ERROR_GROUP_NOT_FOUND",
			status: 404,
		});
	});
});

describe("keeping it", () => {
	test("a cause not seen for 30 days is deleted by the daily prune", async () => {
		const isolated = await createTestInstall();
		try {
			// Sessions end after a week unused: the Superadmin signs in again each time.
			const kept = async () => (await (await isolated.superadmin()).api.errorLog.list({ state: "all" })).groups;
			await isolated.jobs.send(samplePing, { url: "https://old.unreachable.example/" });
			// The job is tried three times, a minute apart; then it is seen no more.
			for (let attempt = 0; attempt < 3; attempt++) {
				await isolated.drainJobs();
				await isolated.clock.advance(2 * 60_000);
			}
			const old = (await kept())[0]?.id ?? "";
			expect(old).not.toBe("");

			await isolated.clock.advance(29 * 24 * HOUR);
			await isolated.drainJobs();
			// The old failure's retries ran out long ago; it is still kept on day 29.
			expect((await kept()).map((group) => group.id)).toContain(old);

			await isolated.clock.advance(2 * 24 * HOUR);
			await isolated.drainJobs();
			expect((await kept()).map((group) => group.id)).not.toContain(old);
		} finally {
			await isolated.close();
		}
	});
});

describe("what isn't in it", () => {
	test("a Module's own failures: they are in its Module log", async () => {
		const withModule = await createTestInstall({ modules: [sample] });
		try {
			const superadmin = await withModule.superadmin();
			await superadmin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
			const workspace = await withModule.createWorkspace();
			const site = await withModule.createSite(workspace.id);

			await expect(moduleApi<typeof sample>(superadmin, "sample").broken({ siteId: site.id })).rejects.toMatchObject({
				code: "MODULE_FAILED",
			});

			expect((await superadmin.api.modules.log({ moduleId: "sample" })).lines[0]).toMatchObject({ level: "error" });
			expect((await superadmin.api.errorLog.list({ state: "all" })).groups).toEqual([]);
		} finally {
			await withModule.close();
		}
	});
});

describe("a storm of failures", () => {
	test("many failures of one cause at once are one cause, counted, and requests still answer at once", async () => {
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id, { slug: "storm" });
		const origin = await goLive(install, site.id);
		const { media } = await admin.api.media.upload({ siteId: site.id, file: upload(pdf("Storm"), "storm.pdf") });
		const name = (media.url ?? "").replace("/_media/", "");
		const folder = join(install.storageDir, workspace.id, site.id, "media");
		// The failure earlier in this file has the same cause.
		const before = (await groups()).find((group) => group.message.includes("EACCES"))?.count ?? 0;

		chmodSync(folder, 0o000);
		let statuses: number[];
		try {
			statuses = (
				await Promise.all(Array.from({ length: 200 }, () => install.request(`${origin}/_media/${name}`)))
			).map((answer) => answer.status);
		} finally {
			chmodSync(folder, 0o755);
		}

		expect(new Set(statuses)).toEqual(new Set([500]));
		const storm = (await groups()).filter((group) => group.message.includes("EACCES"));
		expect(storm).toHaveLength(1);
		expect(storm[0]?.count).toBe(before + 200);
	});
});
