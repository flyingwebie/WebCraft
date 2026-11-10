// How long the Audit log keeps entries: 1 year unless the Superadmin chooses another, removed every
// day by the worker.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";

const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;
let account: TestAccount;
let superadmin: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	account = await install.createSuperadmin();
});

/** Signs the Superadmin in again: sessions end while the clock moves months ahead. Signing in checks who they are. */
async function signIn(): Promise<void> {
	superadmin = await install.signIn(account);
}

async function createWorkspace(name: string): Promise<void> {
	await signIn();
	await superadmin.api.workspaces.create({ name });
}

afterAll(async () => {
	await install.close();
});

/** The names of the Workspaces whose creation the Audit log still holds. */
async function createdWorkspaces(): Promise<unknown[]> {
	await signIn();
	const { entries } = await superadmin.api.audit.list({ action: "workspace.create", limit: 200 });
	return entries.map((entry) => entry.details.name).reverse();
}

test("entries are kept 1 year by default, then removed by the daily prune", async () => {
	await signIn();
	expect(await superadmin.api.install.security.auditRetention()).toEqual({ days: 365 });
	await createWorkspace("Old Ltd");
	await install.clock.advance(200 * DAY);
	await createWorkspace("Newer Ltd");

	await install.clock.advance(166 * DAY);
	await install.drainJobs();

	expect(await createdWorkspaces()).toEqual(["Newer Ltd"]);
});

test("the Superadmin chooses how long, which is recorded", async () => {
	await createWorkspace("Kept Ltd");

	expect(await superadmin.api.install.security.setAuditRetention({ days: 730 })).toEqual({ days: 730 });
	await install.clock.advance(400 * DAY);
	await install.drainJobs();

	expect(await createdWorkspaces()).toContain("Kept Ltd");
	const [change] = (await superadmin.api.audit.list({ action: "auditRetention.change" })).entries;
	expect(change?.details).toEqual({ from: 365, to: 730 });

	await signIn();
	await superadmin.api.install.security.setAuditRetention({ days: 90 });
	await install.clock.advance(DAY);
	await install.drainJobs();
	expect(await createdWorkspaces()).not.toContain("Kept Ltd");
	// The change to 90 days is newer than 90 days, so it stays.
	expect((await superadmin.api.audit.list({ action: "auditRetention.change" })).entries[0]?.details).toEqual({
		from: 730,
		to: 90,
	});
});

test("never less than 90 days, nor more than 10 years", async () => {
	await signIn();

	await expect(superadmin.api.install.security.setAuditRetention({ days: 30 })).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
	await expect(superadmin.api.install.security.setAuditRetention({ days: 3651 })).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
});

test("only the Superadmin changes it", async () => {
	await signIn();
	const { workspace } = await superadmin.api.workspaces.create({ name: "Staffed Ltd" });
	const staff = await install.createStaff({ workspaces: [workspace.id] });

	await expect(staff.browser.api.install.security.setAuditRetention({ days: 400 })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(staff.browser.api.install.security.auditRetention()).rejects.toMatchObject({ code: "FORBIDDEN" });
});
