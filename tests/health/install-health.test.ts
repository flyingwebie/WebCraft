// Install health (spec story 14): the Superadmin's view of whether the Install works, part by part
// (web, worker, database, job queue, storage, last Backup, Failing SMTP, domains, the Error log and
// the Module log), each OK, Warning or Failing with a reason. Worked out by the worker every minute
// and when the screen opens (`refresh`), here with the conditions each part looks at faked.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type HealthPart, samplePing } from "@webcraft/core";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { sample } from "../modules/sample/index.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	await (await install.superadmin()).api.modules.approve({ moduleId: "sample", version: "1.0.0" });
});

afterAll(async () => {
	await install.close();
});

/** The Superadmin's browser, signed in again when a test moved the clock past the session's end. */
const admin = (): Promise<TestBrowser> => install.superadmin();

/** Every part, worked out now, as the screen shows it when it opens. */
async function checked() {
	return (await (await admin()).api.installHealth.get({ refresh: true })).parts;
}

/** One part, worked out now. */
async function part(name: HealthPart) {
	const found = (await checked()).find((row) => row.part === name);
	if (!found) throw new Error(`Install health has no part ${name}.`);
	return found;
}

const SMTP = {
	host: "smtp.agency.example",
	port: 587,
	security: "starttls" as const,
	username: null,
	fromAddress: "noreply@agency.example",
	replyTo: null,
};

describe("the parts", () => {
	test("are listed in order, each with a status and a reason", async () => {
		const parts = await checked();

		expect(parts.map((row) => row.part)).toEqual([
			"web",
			"worker",
			"database",
			"jobQueue",
			"storage",
			"backups",
			"smtp",
			"domains",
			"errorLog",
			"moduleLog",
		]);
		expect(parts.find((row) => row.part === "web")).toMatchObject({
			status: "ok",
			reason: { code: "answering" },
		});
		expect(parts.find((row) => row.part === "database")).toMatchObject({ status: "ok", reason: { code: "current" } });
	});

	test("a healthy Install is OK throughout", async () => {
		const superadmin = await admin();
		await superadmin.api.install.smtp.update(SMTP);
		await install.backup();
		await install.drainJobs();

		const parts = await checked();

		expect(parts.filter((row) => row.status !== "ok")).toEqual([]);
	});
});

describe("the worker", () => {
	test("is Failing once it hasn't checked in for 2 minutes, saying when it last did; OK again when it does", async () => {
		await install.drainJobs({ only: [] });
		const lastBeat = install.clock.now();
		await install.clock.advance(MINUTE);
		expect(await part("worker")).toMatchObject({ status: "ok", reason: { code: "working" } });

		await install.clock.advance(2 * MINUTE);
		expect(await part("worker")).toMatchObject({
			status: "failing",
			reason: { code: "stale", data: { lastBeatAt: lastBeat.toISOString(), hostname: "test-worker" } },
			failingSince: install.clock.now(),
		});
		// While it is down, waiting jobs are the worker's problem, said once: the job queue is only a Warning.

		await install.drainJobs({ only: [] });
		expect(await part("worker")).toMatchObject({ status: "ok", failingSince: null });
	});
});

describe("the job queue", () => {
	test("failed jobs make it a Warning; each can be retried or discarded, or a whole queue, recorded in the Audit log", async () => {
		await install.jobs.send(samplePing, { url: "https://first.unreachable.example/" });
		await install.jobs.send(samplePing, { url: "https://second.unreachable.example/" });
		// Tried three times a minute apart, then failed for good.
		for (let attempt = 0; attempt < 3; attempt++) {
			await install.drainJobs();
			await install.clock.advance(2 * MINUTE);
		}
		await install.drainJobs({ only: [] });

		expect(await part("jobQueue")).toMatchObject({
			status: "warning",
			reason: { code: "failed", data: { failed: 2, queues: ["sample.ping"] } },
		});
		const superadmin = await admin();
		const [queue] = (await superadmin.api.installHealth.queues()).queues;
		expect(queue).toMatchObject({ queue: "sample.ping", failed: 2, stuck: 0 });
		expect(queue?.jobs).toHaveLength(2);
		expect(queue?.jobs[0]).toMatchObject({ attempts: 3, error: { name: "UnexpectedRequestError" } });
		expect(JSON.stringify(queue)).not.toContain('first.unreachable.example/"');

		// Retry one: it goes back in the queue and runs (and fails) again.
		const first = queue?.jobs[0]?.id ?? "";
		const second = queue?.jobs[1]?.id ?? "";
		install.http.respond("GET", /^https:\/\/(first|second)\.unreachable\.example\//, { status: 204 });
		expect(await superadmin.api.installHealth.retry({ queue: "sample.ping", jobIds: [first] })).toEqual({
			retried: 1,
		});
		expect((await install.drainJobs()).completed.map((run) => run.name)).toContain("sample.ping");
		expect((await superadmin.api.installHealth.queues()).queues[0]?.jobs.map((job) => job.id)).toEqual([second]);

		// Discard the rest of the queue: gone for good, and the job queue is OK.
		expect(await superadmin.api.installHealth.discard({ queue: "sample.ping", jobIds: "all" })).toEqual({
			discarded: 1,
		});
		expect((await superadmin.api.installHealth.queues()).queues).toEqual([]);
		expect(await part("jobQueue")).toMatchObject({ status: "ok", reason: { code: "clear" } });

		const audit = (await superadmin.api.audit.list({})).entries.filter((entry) => entry.action.startsWith("job."));
		expect(audit.map(({ action, details }) => ({ action, details }))).toEqual([
			{ action: "job.discard", details: { queue: "sample.ping", jobs: "all", count: 1 } },
			{ action: "job.retry", details: { queue: "sample.ping", jobs: [first], count: 1 } },
		]);
	});

	test("a queue WebCraft doesn't have is refused", async () => {
		await expect((await admin()).api.installHealth.retry({ queue: "no.such", jobIds: "all" })).rejects.toMatchObject({
			code: "JOB_QUEUE_NOT_FOUND",
		});
	});

	test("jobs waiting long past their time while a worker runs are stuck: Failing", async () => {
		install.http.respond("GET", "https://stuck.example/", { status: 204 });
		await install.jobs.send(samplePing, { url: "https://stuck.example/" });
		await install.clock.advance(20 * MINUTE);
		// A worker checks in, but nothing picks the job up.
		await install.drainJobs({ only: [] });

		expect(await part("jobQueue")).toMatchObject({
			status: "failing",
			reason: { code: "stuck", data: { stuck: 1, queues: ["sample.ping"] } },
		});

		await install.drainJobs();
		expect(await part("jobQueue")).toMatchObject({ status: "ok" });
	});
});

describe("storage", () => {
	test("is Failing when WebCraft can't write to it, OK again once it can", async () => {
		// The storage folder becomes read-only, as a disk mounted read-only would be.
		const folders = [
			install.storageDir,
			...readdirSync(install.storageDir).map((name) => join(install.storageDir, name)),
		];
		for (const folder of folders) chmodSync(folder, 0o555);
		try {
			expect(await part("storage")).toMatchObject({
				status: "failing",
				reason: { code: "unwritable", data: { kind: "disk", problem: "EACCES" } },
			});
		} finally {
			for (const folder of folders) chmodSync(folder, 0o755);
		}
		expect(await part("storage")).toMatchObject({ status: "ok", reason: { code: "writable" } });
	});

	test("is a Warning with little room left, Failing with almost none", async () => {
		const GB = 1024 ** 3;
		install.disk.set({ freeBytes: 1.5 * GB, totalBytes: 100 * GB });
		expect(await part("storage")).toMatchObject({
			status: "warning",
			reason: { code: "lowSpace", data: { freeBytes: 1.5 * GB, totalBytes: 100 * GB } },
		});

		install.disk.set({ freeBytes: 100 * 1024 ** 2, totalBytes: 100 * GB });
		expect(await part("storage")).toMatchObject({ status: "failing", reason: { code: "full" } });

		install.disk.set({ freeBytes: 60 * GB, totalBytes: 100 * GB });
		expect(await part("storage")).toMatchObject({ status: "ok" });
	});
});

describe("the last Backup", () => {
	test("against its daily schedule: late after 26 hours, Failing after 50, and Failing when the last one failed", async () => {
		const isolated = await createTestInstall();
		try {
			const backups = async () =>
				(await (await isolated.superadmin()).api.installHealth.get({ refresh: true })).parts.find(
					(row) => row.part === "backups",
				);
			expect(await backups()).toMatchObject({ status: "warning", reason: { code: "never" } });

			await isolated.backup();
			const doneAt = isolated.clock.now();
			expect(await backups()).toMatchObject({
				status: "ok",
				reason: { code: "recent", data: { lastDoneAt: doneAt.toISOString(), scheduled: true } },
			});

			await isolated.clock.advance(27 * HOUR);
			expect(await backups()).toMatchObject({ status: "warning", reason: { code: "late" } });
			await isolated.clock.advance(24 * HOUR);
			expect(await backups()).toMatchObject({ status: "failing", reason: { code: "overdue" } });

			chmodSync(isolated.backupDir, 0o555);
			try {
				await expect(isolated.backup()).rejects.toThrow();
			} finally {
				chmodSync(isolated.backupDir, 0o755);
			}
			expect(await backups()).toMatchObject({ status: "failing", reason: { code: "failed" } });
		} finally {
			await isolated.close();
		}
	});
});

describe("Failing SMTP", () => {
	test("the Install SMTP not set is a Warning; Failing when its last 3 sends failed", async () => {
		const isolated = await createTestInstall();
		try {
			const superadmin = await isolated.superadmin();
			const smtp = async () =>
				(await superadmin.api.installHealth.get({ refresh: true })).parts.find((row) => row.part === "smtp");
			expect(await smtp()).toMatchObject({ status: "warning", reason: { code: "notSet" } });

			await superadmin.api.install.smtp.update(SMTP);
			expect(await smtp()).toMatchObject({ status: "ok", reason: { code: "working" } });

			isolated.mail.fail("535 5.7.8 Authentication failed");
			for (const n of [1, 2, 3]) {
				await isolated.sendSystemEmail({
					type: "password-reset",
					to: { email: `reset-${n}@agency.example` },
					data: { resetPath: "/reset-password?token=x", expiresInMinutes: 30 },
				});
			}
			await isolated.drainJobs();

			expect(await smtp()).toMatchObject({
				status: "failing",
				reason: { code: "failing", data: { lastResponse: "535 5.7.8 Authentication failed" } },
			});
		} finally {
			await isolated.close();
		}
	});
});

describe("domains", () => {
	test("a live domain the Install has no certificate for is Failing; one whose DNS moved away is a Warning", async () => {
		const isolated = await createTestInstall();
		try {
			const superadmin = await isolated.superadmin();
			const workspaceId = (await isolated.createWorkspace()).id;
			const live = async (name: string) => {
				const { id: siteId } = await isolated.createSite(workspaceId, { name: `Site of ${name}` });
				await superadmin.api.domains.add({ siteId, name });
				isolated.connectDomain(name);
				await isolated.clock.advance(MINUTE);
				await isolated.drainJobs();
				return siteId;
			};
			const domains = async () =>
				(await (await isolated.superadmin()).api.installHealth.get({ refresh: true })).parts.find(
					(row) => row.part === "domains",
				);
			const movedSite = await live("moved-bakery.example");
			await live("bare-bakery.example");
			expect(await domains()).toMatchObject({ status: "ok", reason: { code: "reachable" } });

			isolated.dns.answer("moved-bakery.example", ["198.51.100.99"]);
			await isolated.clock.advance(HOUR);
			await isolated.drainJobs();
			expect(await domains()).toMatchObject({
				status: "warning",
				reason: {
					code: "elsewhere",
					data: {
						count: 1,
						domains: [
							{
								name: "moved-bakery.example",
								problem: "dns",
								site: { id: movedSite, name: "Site of moved-bakery.example" },
							},
						],
					},
				},
			});

			isolated.tls.answer("bare-bakery.example", null);
			await isolated.clock.advance(HOUR);
			await isolated.drainJobs();
			expect(await domains()).toMatchObject({ status: "failing", reason: { code: "unreachable", data: { count: 2 } } });
		} finally {
			await isolated.close();
		}
	});
});

describe("the Error log and the Module log", () => {
	test("a new cause in the Error log is a Warning until it is marked resolved", async () => {
		await install.jobs.send(samplePing, { url: "https://cause.unreachable.example/" });
		await install.drainJobs();
		expect(await part("errorLog")).toMatchObject({ status: "warning", reason: { code: "newCauses" } });

		const superadmin = await admin();
		for (const group of (await superadmin.api.errorLog.list({})).groups) {
			await superadmin.api.errorLog.resolve({ groupId: group.id });
		}
		expect(await part("errorLog")).toMatchObject({ status: "ok", reason: { code: "quiet" } });
	});

	test("a Module's failure in the last day is a Warning", async () => {
		const superadmin = await admin();
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id);
		await expect(moduleApi<typeof sample>(superadmin, "sample").broken({ siteId: site.id })).rejects.toMatchObject({
			code: "MODULE_FAILED",
		});

		expect(await part("moduleLog")).toMatchObject({
			status: "warning",
			reason: { code: "failures", data: { count: 1, modules: ["sample"] } },
		});
		await install.clock.advance(25 * HOUR);
		expect(await part("moduleLog")).toMatchObject({ status: "ok" });
	});
});

describe("who sees it", () => {
	test("only the Superadmin: Staff and Members are refused, and see no banner", async () => {
		const workspace = await install.createWorkspace();
		const { browser: staff } = await install.createStaff({ workspaces: "all" });
		const { browser: owner } = await install.createMember({ workspaceId: workspace.id, role: "owner" });

		for (const browser of [staff, owner]) {
			await expect(browser.api.installHealth.get({})).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(browser.api.installHealth.queues()).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect((await browser.api.shell.context()).banners.health).toBeNull();
		}
	});
});
