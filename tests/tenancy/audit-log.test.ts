// The Audit log is append-only: entries are written and never changed. Like tampering.test.ts,
// these tests act as someone with write access to the database, so they name the table that holds
// the entries (`audit_log`): there is no other way to try to change one.
import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let database: pg.Client;

beforeAll(async () => {
	install = await createTestInstall();
	database = new pg.Client({ connectionString: install.databaseUrl });
	await database.connect();
});

afterAll(async () => {
	await database.end();
	await install.close();
});

test("an entry can't be changed, even with access to the database", async () => {
	await install.createWorkspace("Acme Ltd");

	await expect(database.query("UPDATE audit_log SET action = 'nothing.happened'")).rejects.toThrow(
		"Audit log entries can't be changed",
	);
	await expect(database.query("TRUNCATE audit_log")).rejects.toThrow("Audit log entries can't be changed");

	const { entries } = await (await install.superadmin()).api.audit.list();
	expect(entries.map((entry) => entry.action)).toContain("workspace.create");
});
