// A Backup holds the whole database: password hashes, sessions, what visitors sent through Forms, the
// Email log. On the server it is a file like any other, so only its owner may read it, whatever the
// folder around it allows: the archive is written owner-only, and so is a folder WebCraft makes for it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let root: string;

/** A file's or folder's permissions, as `ls -l` shows them in octal. */
const modeOf = (path: string) => (statSync(path).mode & 0o777).toString(8);

beforeAll(async () => {
	install = await createTestInstall();
	await install.createWorkspace("Acme Ltd");
	root = mkdtempSync(join(tmpdir(), "webcraft-backup-modes-"));
});

afterAll(async () => {
	await install.close();
	rmSync(root, { recursive: true, force: true });
});

test("a Backup in the Backups folder is readable by its owner only, and so is the folder when WebCraft makes it", async () => {
	// The Backups folder isn't there yet, as on a server's first Backup.
	rmSync(install.backupDir, { recursive: true, force: true });

	const taken = await install.backup();

	expect(dirname(taken.location)).toBe(install.backupDir);
	expect(modeOf(taken.location)).toBe("600");
	expect(modeOf(install.backupDir)).toBe("700");
});

test("so is one written where `webcraft admin backup --to` says, with the folder made for it", async () => {
	const named = join(root, "offsite", "before-the-move.tar");

	const taken = await install.backup({ to: named });

	expect(taken.location).toBe(named);
	expect(modeOf(named)).toBe("600");
	expect(modeOf(join(root, "offsite"))).toBe("700");
});
