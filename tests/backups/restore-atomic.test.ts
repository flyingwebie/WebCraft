// A restore is all or nothing. `webcraft admin restore --force` replaces an Install's database, which
// people reach for when something has already gone wrong: so the whole Backup is checked before
// anything is deleted (it ends where it should, every table its manifest lists is there with the rows
// it says, every file has a place in storage), and whatever fails after that is undone, leaving the
// database exactly as it was.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cutShort, manifestOf, withExtraFile, withManifest } from "../harness/backups.ts";
import { pdf, upload } from "../harness/images.ts";
import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";

let source: TestInstall;
let superadmin: TestAccount;
let sourceWorkspace: string;
let folder: string;
let archive: string;

/** The name of a test Install's database, which `--force` asks to be typed. */
const databaseName = (install: TestInstall) => new URL(install.databaseUrl).pathname.slice(1);
const replacing = (install: TestInstall) => ({ replace: { confirm: databaseName(install) } });

/** The Workspaces an Install holds, as its Superadmin lists them. */
async function workspacesOf(install: TestInstall): Promise<string[]> {
	const { workspaces } = await (await install.superadmin()).api.workspaces.list();
	return workspaces.map((each) => each.name);
}

async function readiness(install: TestInstall) {
	return ((await (await install.request(install.adminUrl("/readyz"))).json()) as { checks: { schema: string } }).checks
		.schema;
}

/** Restores and answers how it failed (the test fails when it went ahead). */
async function failure(install: TestInstall, file: string, options?: Parameters<TestInstall["restore"]>[1]) {
	const error = await install.restore(file, options).then(
		() => null,
		(failed: unknown) => failed as Error & { refusal?: { reason: string } },
	);
	if (!error) throw new Error("The restore went ahead.");
	return { name: error.name, reason: error.refusal?.reason, message: error.message };
}

beforeAll(async () => {
	folder = await mkdtemp(join(tmpdir(), "webcraft-restore-test-"));
	source = await createTestInstall();
	superadmin = await source.createSuperadmin();
	sourceWorkspace = (await source.createWorkspace("Acme Ltd")).id;
	const siteId = (await source.createSite(sourceWorkspace, { name: "Acme Bakery", slug: "bakery" })).id;
	// A file in local storage, which the Backup carries.
	const bytes = new Uint8Array(40_000);
	bytes.set(pdf("the menu"));
	await (await source.superadmin()).api.media.upload({ siteId, file: upload(bytes, "menu.pdf") });
	archive = (await source.backup({ to: folder })).location;
});

afterAll(async () => {
	await source.close();
	await rm(folder, { recursive: true, force: true });
});

describe("replacing an Install with a Backup that isn't whole", () => {
	let other: TestInstall;

	beforeAll(async () => {
		other = await createTestInstall();
		await other.createWorkspace("Nimbus Bikes");
	});

	afterAll(async () => {
		await other.close();
	});

	/** The Install is exactly as it was: its own data, on a current schema. */
	async function expectUntouched() {
		expect(await workspacesOf(other)).toEqual(["Nimbus Bikes"]);
		expect(await readiness(other)).toBe("current");
	}

	test("one cut short among its files is refused before anything is deleted", async () => {
		const cut = join(folder, "cut-in-files.tar");
		cutShort(archive, cut, 20_000);

		const refused = await failure(other, cut, replacing(other));

		expect(refused).toMatchObject({ name: "RestoreRefusedError", reason: "not-a-backup" });
		await expectUntouched();
	});

	test("one cut short among its tables is refused before anything is deleted", async () => {
		const cut = join(folder, "cut-in-tables.tar");
		cutShort(archive, cut, Math.floor(statSync(archive).size * 0.6));

		const refused = await failure(other, cut, replacing(other));

		expect(refused).toMatchObject({ name: "RestoreRefusedError", reason: "not-a-backup" });
		await expectUntouched();
	});

	test("one whose table holds other rows than its manifest says is refused before anything is deleted", async () => {
		const miscounted = join(folder, "miscounted.tar");
		withManifest(archive, miscounted, (manifest) => {
			const tables = (manifest.database as { tables: { name: string; rows: number }[] }).tables;
			const workspaces = tables.find((table) => table.name === "public.workspaces");
			if (!workspaces) throw new Error("The Backup has no Workspaces table.");
			workspaces.rows += 1;
		});

		const refused = await failure(other, miscounted, replacing(other));

		expect(refused).toMatchObject({ name: "RestoreRefusedError", reason: "not-a-backup" });
		expect(refused.message).toContain("public.workspaces");
		await expectUntouched();
	});

	test("one missing a table its manifest lists is refused before anything is deleted", async () => {
		const missing = join(folder, "missing-table.tar");
		withManifest(archive, missing, (manifest) => {
			const tables = (manifest.database as { tables: { name: string; file: string }[] }).tables;
			const workspaces = tables.find((table) => table.name === "public.workspaces");
			if (!workspaces) throw new Error("The Backup has no Workspaces table.");
			workspaces.file = "database/somewhere-else.copy.gz";
		});

		const refused = await failure(other, missing, replacing(other));

		expect(refused).toMatchObject({ name: "RestoreRefusedError", reason: "not-a-backup" });
		await expectUntouched();
	});

	test("one holding a file with no place in storage is refused, and the file is written nowhere", async () => {
		const escaping = join(folder, "escaping.tar");
		const listed = join(folder, "escaping-listed.tar");
		withManifest(archive, listed, (manifest) => {
			(manifest.files as { local: { count: number } }).local.count += 1;
		});
		withExtraFile(listed, escaping, "files/../escaped.txt", "out of the storage folder");

		const refused = await failure(other, escaping, replacing(other));

		expect(refused).toMatchObject({ name: "RestoreRefusedError", reason: "not-a-backup" });
		expect(existsSync(join(dirname(other.storageDir), "escaped.txt"))).toBe(false);
		await expectUntouched();
	});

	test("a failure after the check (a file that can't be written) undoes everything; the restore then works once it can", async () => {
		// Something in the way of the Workspace's folder in local storage.
		const inTheWay = join(other.storageDir, sourceWorkspace);
		writeFileSync(inTheWay, "not a folder");

		const failed = await failure(other, archive, replacing(other));

		expect(failed.name).toBe("RestoreFailedError");
		expect(failed.message).toContain("as it was");
		await expectUntouched();

		await rm(inTheWay);
		const report = await other.restore(archive, replacing(other));
		expect(report.files).toBe(manifestCount());
		expect(await workspacesOf(other)).toEqual(["Acme Ltd"]);
		expect(await readiness(other)).toBe("current");
		const admin = await other.signIn(superadmin);
		expect((await admin.api.session.current()).person?.email).toBe(superadmin.email);
	});
});

describe("restoring into an empty database", () => {
	test("a failure leaves it empty, so the restore is simply run again", async () => {
		const empty = await createTestInstall({ database: "empty" });
		try {
			const inTheWay = join(empty.storageDir, sourceWorkspace);
			writeFileSync(inTheWay, "not a folder");

			expect((await failure(empty, archive)).name).toBe("RestoreFailedError");
			expect(await readiness(empty)).toBe("behind");

			await rm(inTheWay);
			// No --force: the database holds nothing.
			await empty.restore(archive);
			const { workspaces } = await (await empty.signIn(superadmin)).api.workspaces.list();
			expect(workspaces.map((each) => each.name)).toEqual(["Acme Ltd"]);
			const stored = readFileSync(join(empty.storageDir, ...storedFile().split("/")));
			expect(stored.byteLength).toBe(40_000);
		} finally {
			await empty.close();
		}
	});
});

/** How many files of local storage the Backup lists. */
function manifestCount(): number {
	return (manifestOf(archive).files as { local: { count: number } }).local.count;
}

/** The storage key of the Backup's uploaded file, read from the archive's own listing. */
function storedFile(): string {
	const listed = new RegExp(`files/(${sourceWorkspace}/[A-Za-z0-9._/-]+)`).exec(
		readFileSync(archive).toString("latin1"),
	);
	if (!listed?.[1]) throw new Error("The Backup holds no file of the Workspace.");
	return listed[1];
}
