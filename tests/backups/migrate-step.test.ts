// The migrate step (ADR 0031), as `webcraft admin migrate` runs it: when anything is pending it takes
// a Backup first (`--no-backup` skips it, and says so), each migration runs in its own transaction,
// every job queue is made, and the previous version keeps working on the migrated database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { coreJobs } from "@webcraft/core";
import type { ModuleDefinition, ModuleMigration } from "@webcraft/module-sdk";

import { manifestOf } from "../harness/backups.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { sample } from "../modules/sample/index.ts";

/** The sample Module at a later version, with more migrations. */
function sampleWith(version: string, migrations: readonly ModuleMigration[]): ModuleDefinition {
	return {
		...sample,
		manifest: { ...sample.manifest, version },
		migrations: [...(sample.migrations ?? []), ...migrations],
	};
}

const addColour: ModuleMigration = { name: "0002-colour", sql: "ALTER TABLE notes ADD COLUMN colour text;" };
const addSize: ModuleMigration = { name: "0003-size", sql: "ALTER TABLE notes ADD COLUMN size integer;" };

async function readiness(install: TestInstall) {
	return ((await (await install.request(install.adminUrl("/readyz"))).json()) as { checks: { schema: string } }).checks
		.schema;
}

describe("on a new database", () => {
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall({ database: "empty" });
	});

	afterAll(async () => {
		await install.close();
	});

	test("there is nothing to back up; every migration and every job queue is made", async () => {
		const report = await install.migrate({ backup: true });

		expect(report.backup).toEqual({ state: "not-needed", reason: "new-database" });
		expect(report.appliedMigrations.length).toBeGreaterThan(30);
		// A job sent before the worker ever started waits in its queue.
		expect(report.createdQueues.sort()).toEqual(coreJobs.map((job) => job.name).sort());
		expect(readdirSync(install.backupDir)).toEqual([]);
		expect(await readiness(install)).toBe("current");
	});

	test("run again, nothing is pending: no Backup, no queue made", async () => {
		const report = await install.migrate({ backup: true });

		expect(report.backup).toEqual({ state: "not-needed", reason: "nothing-pending" });
		expect(report.appliedMigrations).toEqual([]);
		expect(report.createdQueues).toEqual([]);
	});
});

describe("with migrations pending on an Install", () => {
	let install: TestInstall;

	beforeAll(async () => {
		install = await createTestInstall({ modules: [sample] });
		await install.createWorkspace("Acme Ltd");
	});

	afterAll(async () => {
		await install.close();
	});

	test("a Backup is taken first, before anything changes", async () => {
		const updated = sampleWith("1.1.0", [addColour]);
		await install.restart({ modules: [updated] });

		const report = await install.migrate({ backup: true });

		expect(report.appliedMigrations).toEqual(["sample/0002-colour"]);
		expect(report.backup.state).toBe("taken");
		const location = report.backup.state === "taken" ? report.backup.backup.location : "";
		expect(location.startsWith(install.backupDir)).toBe(true);
		expect(existsSync(location)).toBe(true);
		// Taken before the migration: the Backup's database didn't have it.
		const manifest = manifestOf(location) as unknown as {
			reason: string;
			migrations: { modules: Record<string, string[]> };
		};
		expect(manifest.reason).toBe("before-migrations");
		expect(manifest.migrations.modules.sample).toEqual(["0001-notes"]);
		const { backups } = await (await install.superadmin()).api.install.backups.get();
		expect(backups[0]).toMatchObject({ reason: "before-migrations", status: "done", target: "folder" });
	});

	test("--no-backup skips it, and the report says so", async () => {
		await install.restart({ modules: [sampleWith("1.2.0", [addColour, addSize])] });

		const report = await install.migrate({ backup: false });

		expect(report.backup).toEqual({ state: "skipped" });
		expect(report.appliedMigrations).toEqual(["sample/0003-size"]);
	});

	test("going back one version: the previous version's migrate step and start-up accept the newer database", async () => {
		await install.restart({ modules: [sampleWith("1.1.0", [addColour])] });

		const report = await install.migrate({ backup: true });

		expect(report.appliedMigrations).toEqual([]);
		expect(report.backup).toEqual({ state: "not-needed", reason: "nothing-pending" });
		expect(await readiness(install)).toBe("current");
	});
});

test("each migration runs in its own transaction: a failure keeps the ones before it", async () => {
	const install = await createTestInstall({ modules: [sample] });
	try {
		const broken = sampleWith("1.1.0", [
			addColour,
			{ name: "0003-size", sql: "ALTER TABLE nowhere ADD COLUMN size integer;" },
		]);
		const failure = await install.migrate({ modules: [broken] }).then(
			() => null,
			(error: unknown) => error as Error,
		);
		expect(failure?.message).toContain("0003-size failed");

		// Fixed in the next release: only the migration that failed is still pending.
		const report = await install.migrate({ modules: [sampleWith("1.1.1", [addColour, addSize])] });
		expect(report.appliedMigrations).toEqual(["sample/0003-size"]);
	} finally {
		await install.close();
	}
});

test("a migrate step that fails stops before anything else changes, the Backup already taken", async () => {
	const install = await createTestInstall({ modules: [sample] });
	try {
		await install.createWorkspace("Acme Ltd");
		const broken = sampleWith("1.1.0", [{ name: "0002-broken", sql: "ALTER TABLE nowhere ADD COLUMN size integer;" }]);
		await install.restart({ modules: [broken] });

		await expect(install.migrate({ backup: true })).rejects.toThrow("0002-broken failed");

		expect(readdirSync(install.backupDir)).toEqual([
			expect.stringMatching(/^webcraft-backup-\d{8}-\d{6}-before-migrations-[0-9a-f]{4}\.tar$/),
		]);
		expect(await readiness(install)).toBe("behind");
	} finally {
		await install.close();
	}
});
