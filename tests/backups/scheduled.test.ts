// Scheduled Backups: every day (01:11 UTC) while Install settings › Backups has them on, the worker
// takes a Backup into the Backups folder or an S3-compatible bucket, and keeps the newest of each of
// the last 7 days and of each of the last 4 weeks. A failed one is in the Backup log, and the
// Superadmin sees a notice until one succeeds.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { manifestOf } from "../harness/backups.ts";
import {
	createFakeS3,
	createTestInstall,
	type FakeS3,
	TEST_PASSWORD,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";

/** Moves the clock to 01:30 UTC of the next day, after the daily Backup's time, and runs the worker's jobs. */
async function nextNight(install: TestInstall) {
	const now = install.clock.now();
	const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 1, 30);
	await install.clock.advance(next - now.getTime());
	const report = await install.drainJobs();
	expect(report.failed).toEqual([]);
}

/** The days (UTC) of the Backups in the Backups folder, oldest first. */
function daysInFolder(install: TestInstall): string[] {
	return readdirSync(install.backupDir)
		.map((name) => /^webcraft-backup-(\d{4})(\d{2})(\d{2})-/.exec(name))
		.filter((match) => match !== null)
		.map((match) => `${match[1]}-${match[2]}-${match[3]}`)
		.sort();
}

/** The Superadmin's browser, signed in again with a fresh identity check for Sensitive actions. */
async function confirmedSuperadmin(install: TestInstall): Promise<TestBrowser> {
	const admin = await install.superadmin();
	await admin.api.session.confirmIdentity({ password: TEST_PASSWORD });
	return admin;
}

describe("into the Backups folder", () => {
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall({ updateFeed: null });
		await install.createWorkspace("Acme Ltd");
	});

	afterAll(async () => {
		await install.close();
	});

	test("are on by default, every night", async () => {
		const { settings } = await (await install.superadmin()).api.install.backups.get();
		expect(settings).toMatchObject({
			scheduled: true,
			target: "folder",
			folder: install.backupDir,
			s3: null,
			keep: { daily: 7, weekly: 4 },
		});

		await nextNight(install);

		expect(daysInFolder(install)).toEqual(["2026-03-03"]);
		const { backups, status } = await (await install.superadmin()).api.install.backups.get();
		expect(backups).toHaveLength(1);
		expect(backups[0]).toMatchObject({ reason: "scheduled", target: "folder", status: "done", problem: null });
		expect(backups[0]?.sizeBytes).toBeGreaterThan(0);
		expect(status).toMatchObject({ failing: false, lastDone: { id: backups[0]?.id } });
		const archive = backups[0]?.location ?? "";
		expect(manifestOf(archive)).toMatchObject({ reason: "scheduled" });
	});

	// It takes a Backup for each of many days: give it room on a busy machine.
	test("keep the newest of each of the last 7 days and of each of the last 4 weeks", async () => {
		for (let night = 0; night < 39; night++) await nextNight(install);

		// 40 nights, Tuesday 3 March to Saturday 11 April: the last 7 days, and the newest of the four
		// weeks before (Sunday 22 and 29 March; 5 and 11 April are among the last 7 days already).
		expect(daysInFolder(install)).toEqual([
			"2026-03-22",
			"2026-03-29",
			"2026-04-05",
			"2026-04-06",
			"2026-04-07",
			"2026-04-08",
			"2026-04-09",
			"2026-04-10",
			"2026-04-11",
		]);
		const { backups } = await (await install.superadmin()).api.install.backups.get();
		expect(backups.filter((backup) => backup.removedAt === null)).toHaveLength(9);
	}, 120_000);

	test("Backups taken by command or before migrations aren't removed by the keep rules", async () => {
		const taken = await install.backup();
		for (let night = 0; night < 10; night++) await nextNight(install);

		expect(readdirSync(install.backupDir)).toContain(taken.name);
	});

	test("taken no more once switched off", async () => {
		const admin = await confirmedSuperadmin(install);
		await admin.api.install.backups.update({ scheduled: false, target: { kind: "folder" } });
		const before = readdirSync(install.backupDir).length;

		await nextNight(install);

		expect(readdirSync(install.backupDir)).toHaveLength(before);
		const { entries } = await admin.api.audit.list({ limit: 1 });
		expect(entries[0]).toMatchObject({ action: "backups.change", details: { scheduled: false, target: "folder" } });
	});
});

describe("into an S3-compatible bucket", () => {
	const S3 = {
		endpoint: "https://s3.backups.test",
		bucket: "agency-backups",
		region: "eu-west-1",
		accessKeyId: "AKIABACKUPSTEST",
		secretAccessKey: "a-very-secret-backup-key-0123456789",
	};
	const target = (secretAccessKey?: string) => ({
		kind: "s3" as const,
		endpoint: S3.endpoint,
		region: S3.region,
		bucket: S3.bucket,
		prefix: "install-1",
		pathStyle: true,
		accessKeyId: S3.accessKeyId,
		...(secretAccessKey ? { secretAccessKey } : {}),
	});
	let install: TestInstall;
	let bucket: FakeS3;

	beforeAll(async () => {
		install = await createTestInstall({ updateFeed: null });
		bucket = createFakeS3(install.http, S3);
		await install.createWorkspace("Acme Ltd");
	});

	afterAll(async () => {
		await install.close();
	});

	test("the bucket is checked before it is saved, and its secret is kept like every secret", async () => {
		const admin = await confirmedSuperadmin(install);

		await expect(
			admin.api.install.backups.update({ scheduled: true, target: target("a-wrong-secret-key") }),
		).rejects.toMatchObject({ code: "STORAGE_UNREACHABLE" });
		const saved = await admin.api.install.backups.update({ scheduled: true, target: target(S3.secretAccessKey) });

		expect(saved).toMatchObject({
			target: "s3",
			s3: { bucket: S3.bucket, secretAccessKey: { set: true, lastFour: "6789" } },
		});
		expect(JSON.stringify(saved)).not.toContain(S3.secretAccessKey);
		expect(await install.tablesHolding(S3.secretAccessKey)).toEqual([]);
		const { entries } = await admin.api.audit.list({ limit: 1 });
		expect(entries[0]).toMatchObject({
			action: "backups.change",
			details: { target: "s3", secretAccessKey: "replaced" },
		});
	});

	test("Backups go up into the bucket's backups folder, under its prefix", async () => {
		await nextNight(install);

		const keys = [...bucket.objects.keys()].filter((key) => key.startsWith("install-1/backups/"));
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^install-1\/backups\/webcraft-backup-20260303-\d{6}-scheduled-[0-9a-f]{4}\.tar$/);
		expect(bucket.openUploads).toBe(0);
		const { backups } = await (await install.superadmin()).api.install.backups.get();
		expect(backups[0]).toMatchObject({ target: "s3", status: "done", location: `s3://agency-backups/${keys[0]}` });
		expect(readdirSync(install.backupDir)).toEqual([]);
	});

	test("a Backup that fails is in the log, and the Superadmin is told until one succeeds", async () => {
		install.http.respond("POST", /^https:\/\/s3\.backups\.test\//, {
			status: 503,
			body: "<Error><Code>SlowDown</Code></Error>",
		});

		await nextNight(install);

		const admin = await install.superadmin();
		const { backups, status } = await admin.api.install.backups.get();
		expect(backups[0]).toMatchObject({ status: "failed", reason: "scheduled" });
		expect(backups[0]?.problem).toContain("503 SlowDown");
		expect(status.failing).toBe(true);
		expect((await admin.api.shell.context()).banners.backupFailing).toBe(true);
		expect(install.logs.some((entry) => entry.level === "error" && entry.msg === "A Backup failed")).toBe(true);

		// The bucket answers again.
		createFakeS3(install.http, S3);
		await nextNight(install);
		expect((await admin.api.shell.context()).banners.backupFailing).toBe(false);
	});
});
