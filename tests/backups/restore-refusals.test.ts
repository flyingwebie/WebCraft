// `webcraft admin restore` can't make things worse: it refuses a database that holds anything
// (unless told to replace it, with the database's name typed), a Backup from a newer WebCraft or
// with migrations this version doesn't have, a Master key other than the one the Backup was taken
// under (ADR 0032), a database web or worker is running on, and a file that isn't a Backup. A
// Backup from an older version is restored and brought up to this one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { manifestOf, withManifest } from "../harness/backups.ts";
import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";

let source: TestInstall;
let superadmin: TestAccount;
let folder: string;
let archive: string;

/** The name of a test Install's database, which `--force` asks to be typed. */
const databaseName = (install: TestInstall) => new URL(install.databaseUrl).pathname.slice(1);

async function readiness(install: TestInstall) {
	return ((await (await install.request(install.adminUrl("/readyz"))).json()) as { checks: { schema: string } }).checks
		.schema;
}

/** Restores and answers why it was refused (the test fails when it wasn't). */
async function refusal(install: TestInstall, file: string, options?: Parameters<TestInstall["restore"]>[1]) {
	const error = await install.restore(file, options).then(
		() => null,
		(failure: unknown) => failure as Error & { refusal?: { reason: string } },
	);
	if (!error) throw new Error("The restore went ahead.");
	expect(error.name).toBe("RestoreRefusedError");
	return { reason: error.refusal?.reason, message: error.message };
}

beforeAll(async () => {
	folder = await mkdtemp(join(tmpdir(), "webcraft-backup-test-"));
	source = await createTestInstall();
	superadmin = await source.createSuperadmin();
	await source.createWorkspace("Acme Ltd");
	archive = (await source.backup({ to: folder })).location;
});

afterAll(async () => {
	await source.close();
	await rm(folder, { recursive: true, force: true });
});

describe("a database that isn't empty", () => {
	let other: TestInstall;

	beforeAll(async () => {
		other = await createTestInstall();
		await other.createWorkspace("Nimbus Bikes");
	});

	afterAll(async () => {
		await other.close();
	});

	test("is refused, and keeps everything it holds", async () => {
		const refused = await refusal(other, archive);

		expect(refused.reason).toBe("not-empty");
		expect(refused.message).toContain("isn't empty");
		const { workspaces } = await (await other.superadmin()).api.workspaces.list();
		expect(workspaces.map((each) => each.name)).toEqual(["Nimbus Bikes"]);
	});

	test("is replaced only once its name is typed as the confirmation", async () => {
		const refused = await refusal(other, archive, { replace: { confirm: "yes" } });
		expect(refused.reason).toBe("confirmation");
		expect(refused.message).toContain(databaseName(other));

		await other.restore(archive, { replace: { confirm: databaseName(other) } });

		const admin = await other.signIn(superadmin);
		const { workspaces } = await admin.api.workspaces.list();
		expect(workspaces.map((each) => each.name)).toEqual(["Acme Ltd"]);
		expect(await readiness(other)).toBe("current");
	});
});

describe("into an empty database", () => {
	let empty: TestInstall;
	let copies: string;

	beforeAll(async () => {
		empty = await createTestInstall({ database: "empty" });
		copies = await mkdtemp(join(tmpdir(), "webcraft-backup-copies-"));
	});

	afterAll(async () => {
		await empty.close();
		await rm(copies, { recursive: true, force: true });
	});

	test("a Backup from a newer WebCraft is refused", async () => {
		const newer = join(copies, "newer.tar");
		withManifest(archive, newer, (manifest) => {
			manifest.webcraft.version = "99.0.0";
		});

		const refused = await refusal(empty, newer);

		expect(refused.reason).toBe("newer-version");
		expect(refused.message).toContain("WebCraft 99.0.0");
		expect(await readiness(empty)).toBe("behind");
	});

	test("a Backup whose database had migrations this version doesn't have is refused", async () => {
		const newer = join(copies, "newer-migrations.tar");
		withManifest(archive, newer, (manifest) => {
			(manifest.migrations as { core: string[] }).core.push("29990101000000_from-a-newer-version");
		});

		const refused = await refusal(empty, newer);

		expect(refused.reason).toBe("newer-migrations");
		expect(refused.message).toContain("29990101000000_from-a-newer-version");
		expect(await readiness(empty)).toBe("behind");
	});

	test("a file that isn't a Backup is refused", async () => {
		const notOne = join(copies, "notes.txt");
		writeFileSync(notOne, "Not a Backup at all.\n".repeat(100));

		expect((await refusal(empty, notOne)).reason).toBe("not-a-backup");
		expect((await refusal(empty, join(copies, "missing.tar"))).reason).toBe("not-a-backup");
	});

	test("a Backup whose manifest names anything but WebCraft's own tables and monthly partitions is refused, running nothing", async () => {
		const injected = join(copies, "injected-bound.tar");
		withManifest(archive, injected, (manifest) => {
			(manifest.database as { partitions: unknown[] }).partitions.push({
				parent: "m_site_analytics.events",
				name: "events_injected",
				bound:
					"FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00'); CREATE TABLE public.injected (id int); --",
			});
		});
		const foreign = join(copies, "foreign-table.tar");
		withManifest(archive, foreign, (manifest) => {
			const { tables } = manifest.database as { tables: { name: string }[] };
			if (tables[0]) tables[0].name = "pg_catalog.pg_authid";
		});

		expect((await refusal(empty, injected)).reason).toBe("not-a-backup");
		expect((await refusal(empty, foreign)).reason).toBe("not-a-backup");
		const client = new pg.Client({ connectionString: empty.databaseUrl });
		await client.connect();
		try {
			const { rows } = await client.query("SELECT to_regclass('public.injected') AS found");
			expect(rows[0]?.found).toBeNull();
		} finally {
			await client.end();
		}
		expect(await readiness(empty)).toBe("behind");
	});

	test("nothing is restored while web or worker is running on the database", async () => {
		const web = new pg.Client({ connectionString: empty.databaseUrl, application_name: "webcraft-web" });
		await web.connect();
		try {
			const refused = await refusal(empty, archive);
			expect(refused).toMatchObject({ reason: "in-use" });
			expect(refused.message).toContain("Stop them first");
		} finally {
			await web.end();
		}
	});
});

test("a Backup taken under another Master key is refused: the key is never in it", async () => {
	const otherKey = await createTestInstall({ database: "empty", masterKey: "another-master-key-0123456789abcdefghij" });
	try {
		const refused = await refusal(otherKey, archive);

		expect(refused.reason).toBe("master-key");
		expect(refused.message).toContain(manifestOf(archive).masterKey.fingerprint.slice(0, 12));
		expect(await readiness(otherKey)).toBe("behind");
	} finally {
		await otherKey.close();
	}
});

test("a Backup from an older version is restored, then the migrate step brings it up to this one", async () => {
	// The version before this one had no Backups: its database lacked the migration that makes them.
	const migrations = new URL("../../packages/db/src/migrations/", import.meta.url).pathname;
	const lifecycle = readdirSync(migrations).find((name) => name.endsWith("_install-lifecycle")) ?? "";
	const tables = [
		...readFileSync(join(migrations, lifecycle, "migration.sql"), "utf8").matchAll(/CREATE TABLE "(\w+)"/g),
	].map((match) => `public.${match[1]}`);
	const older = join(folder, "older.tar");
	withManifest(archive, older, (manifest) => {
		manifest.webcraft.version = "0.0.9";
		const level = manifest.migrations as { core: string[] };
		level.core = level.core.filter((name) => name !== lifecycle);
		const database = manifest.database as { tables: { name: string }[] };
		database.tables = database.tables.filter((table) => !tables.includes(table.name));
	});
	const fresh = await createTestInstall({ database: "empty" });
	try {
		const report = await fresh.restore(older);

		expect(report.migrations.appliedMigrations).toEqual([lifecycle]);
		expect(await readiness(fresh)).toBe("current");
		const admin = await fresh.signIn(superadmin);
		expect((await admin.api.workspaces.list()).workspaces.map((each) => each.name)).toEqual(["Acme Ltd"]);
	} finally {
		await fresh.close();
	}
});
