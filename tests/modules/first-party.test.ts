// This build's first-party Modules (ADR 0024): each one WebCraft ships must load and run, and its
// migrations must pass the migrate step's checks, or the Install would list it as unable to run.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { FIRST_PARTY_MODULES } from "@webcraft/core";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

test("every first-party Module loads, can run, and waits for the Superadmin's approval", async () => {
	const { modules } = await (await install.superadmin()).api.modules.list();

	expect(modules.map((module) => [module.id, module.status, module.problem])).toEqual(
		FIRST_PARTY_MODULES.map((module) => [module.manifest.id, "waiting", null]),
	);
});

test("every first-party Module's migrations ran and keep the migrate step's rules", async () => {
	expect((await install.migrate()).appliedMigrations).toEqual([]);
	const ready = await install.request(install.adminUrl("/readyz"));
	expect(ready.status).toBe(200);
});
