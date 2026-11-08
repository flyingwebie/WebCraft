// Workspaces: one per client organisation. The Superadmin creates them; everyone else sees only
// the Workspaces they can reach.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

describe("creating Workspaces", () => {
	test("the Superadmin creates a Workspace, and it is listed with no Sites and no Staff", async () => {
		const browser = await install.signIn(superadmin);

		const { workspace } = await browser.api.workspaces.create({ name: "  Acme Ltd " });

		expect(workspace).toEqual({ id: expect.any(String), name: "Acme Ltd", createdAt: install.clock.now() });
		const { workspaces } = await browser.api.workspaces.list();
		expect(workspaces).toContainEqual({ ...workspace, siteCount: 0, staff: [] });
	});

	test("refuses a Workspace without a name", async () => {
		const browser = await install.signIn(superadmin);

		await expect(browser.api.workspaces.create({ name: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("people who aren't signed in can't list or create Workspaces", async () => {
		const browser = install.browser();

		await expect(browser.api.workspaces.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(browser.api.workspaces.create({ name: "Mallory Ltd" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	test("the Audit log records who created the Workspace, when, and how", async () => {
		const browser = await install.signIn(superadmin);
		const { person } = await browser.api.session.current();
		await install.clock.advance(60_000);

		const { workspace } = await browser.api.workspaces.create({ name: "Nimbus Bikes" });

		const { entries } = await browser.api.audit.list();
		expect(entries[0]).toEqual({
			id: expect.any(String),
			at: install.clock.now(),
			action: "workspace.create",
			personId: person?.id ?? null,
			via: { kind: "admin" } as const,
			workspaceId: workspace.id,
			siteId: null,
			details: { name: "Nimbus Bikes" },
		});
	});
});
