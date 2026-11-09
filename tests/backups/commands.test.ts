// The server commands, run for real (in an empty directory, so Bun loads no `.env`, with the
// Install's environment): `webcraft admin backup` writes an archive, `webcraft admin restore` puts it
// into an empty database (refusing one that isn't, unless forced with its name typed), and
// `webcraft admin migrate` says what it did about a Backup.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "apps/cli/src/main.ts");
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-cli-"));
// A real process does the real leaked-password lookup, so this one must not be on any leaked list.
const PASSWORD = "ops team keeps this webcraft install safe 2026";

async function webcraft(install: TestInstall, args: string[], stdin = "") {
	const child = Bun.spawn(["bun", CLI, ...args], {
		cwd: EMPTY_DIRECTORY,
		env: { PATH: process.env.PATH ?? "", ...install.env },
		stdin: new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

let source: TestInstall;
let target: TestInstall;
let folder: string;
let archive: string;

beforeAll(async () => {
	folder = mkdtempSync(join(tmpdir(), "webcraft-backups-"));
	// Migrated by the command, so its database has this build's migrations and nothing else.
	source = await createTestInstall({ database: "empty" });
	expect((await webcraft(source, ["admin", "migrate"])).code).toBe(0);
	expect((await webcraft(source, ["admin", "create-superadmin", "ops@agency.example"], `${PASSWORD}\n`)).code).toBe(0);
	target = await createTestInstall({ database: "empty" });
});

afterAll(async () => {
	await source.close();
	await target.close();
	await rm(folder, { recursive: true, force: true });
	await rm(EMPTY_DIRECTORY, { recursive: true, force: true });
});

describe("webcraft admin backup", () => {
	test("writes one archive where it is told, and says what it holds", async () => {
		const { code, stdout } = await webcraft(source, ["admin", "backup", "--to", folder]);

		expect(code).toBe(0);
		const [name] = readdirSync(folder);
		expect(name).toMatch(/^webcraft-backup-\d{8}-\d{6}-command-[0-9a-f]{4}\.tar$/);
		archive = join(folder, name ?? "");
		expect(stdout).toContain(`Took a Backup: ${archive}`);
		expect(stdout).toContain("It holds no Master key");
	});

	test("goes to the Backups folder without --to", async () => {
		const { code } = await webcraft(source, ["admin", "backup"]);

		expect(code).toBe(0);
		expect(readdirSync(source.backupDir)).toHaveLength(1);
	});
});

describe("webcraft admin restore", () => {
	test("restores into an empty database, then says so", async () => {
		const { code, stdout, stderr } = await webcraft(target, ["admin", "restore", archive]);

		expect(stderr).not.toContain("webcraft:");
		expect(code).toBe(0);
		expect(stdout).toContain("(taken by command)");
		expect(stdout).toContain("Rebuilding the database as it was");
		expect(stdout).toContain("Start web and worker.");
		await target.restart();
		const browser = await target.signIn({ email: "ops@agency.example", password: PASSWORD });
		expect((await browser.api.session.current()).person?.installRole).toBe("superadmin");
	});

	test("refuses a database that isn't empty", async () => {
		const { code, stderr } = await webcraft(target, ["admin", "restore", archive]);

		expect(code).toBe(1);
		expect(stderr).toContain("isn't empty");
		expect(stderr).toContain("--force");
	});

	test("--force without a terminal asks for the database's name with --confirm", async () => {
		const database = new URL(target.databaseUrl).pathname.slice(1);

		const refused = await webcraft(target, ["admin", "restore", archive, "--force"]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain(`--confirm ${database}`);

		const wrong = await webcraft(target, ["admin", "restore", archive, "--force", "--confirm", "webcraft"]);
		expect(wrong.code).toBe(1);
		expect(wrong.stderr).toContain(`type its name, ${database}`);

		const replaced = await webcraft(target, ["admin", "restore", archive, "--force", "--confirm", database]);
		expect(replaced.code).toBe(0);
		expect(replaced.stdout).toContain(`Deleting everything in the database ${database}`);
	});
});

test("webcraft admin migrate says when nothing was pending, and that no Backup was needed", async () => {
	const { code, stdout } = await webcraft(target, ["admin", "migrate"]);

	expect(code).toBe(0);
	expect(stdout).toContain("No migrations were pending.");
	expect(stdout).not.toContain("Backup");
});
