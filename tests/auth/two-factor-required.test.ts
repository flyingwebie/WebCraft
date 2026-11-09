// Requiring two-factor authentication: the Superadmin's switch for the whole Install, an Owner's
// or Staff's for a Workspace's Members; the setup a person who must use it goes through before
// anything else; and the reminder everyone else sees until they add it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import type { TestBrowser } from "../harness/browser.ts";
import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";
import { softwareAuthenticator } from "../harness/passkeys.ts";
import { addAuthenticator, confirmIfAsked, signInWithAuthenticator } from "../harness/two-factor.ts";

const DAY = 24 * 60 * 60_000;

// Each test switches requirements for the whole Install, so each gets an Install of its own.
let install: TestInstall;
let superadmin: TestAccount;
let admin: TestBrowser;
let workspaceId: string;

beforeEach(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
	workspaceId = (await install.createWorkspace("Acme")).id;
	admin = await install.superadmin();
});

afterEach(async () => {
	await install.close();
});

/** The Superadmin adds an authenticator app and signs in with it; answers their new browser. */
async function superadminWithAuthenticator(): Promise<TestBrowser> {
	const { secret } = await addAuthenticator(install, admin, superadmin.password);
	admin = await signInWithAuthenticator(install, superadmin, secret);
	return admin;
}

describe("the Install's switch", () => {
	test("is the Superadmin's, a Sensitive action, recorded in the Audit log, and needs their own second factor first", async () => {
		const staff = await install.createStaff({ workspaces: "all" });
		await expect(staff.browser.api.install.security.requireTwoFactor({ required: true })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(admin.api.install.security.requireTwoFactor({ required: true })).rejects.toMatchObject({
			code: "TWO_FACTOR_OFF",
		});
		await superadminWithAuthenticator();
		await install.clock.advance(11 * 60_000);
		await expect(admin.api.install.security.requireTwoFactor({ required: true })).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
			data: { action: "twoFactorRequirement.change" },
		});

		await admin.api.session.confirmIdentity({ password: superadmin.password });
		await admin.api.install.security.requireTwoFactor({ required: true });

		expect(await admin.api.install.security.get()).toEqual({ leakedPasswordCheck: true, requireTwoFactor: true });
		const entry = (await admin.api.audit.list()).entries.find(
			(found) => found.action === "twoFactorRequirement.change",
		);
		expect(entry).toMatchObject({ workspaceId: null, details: { from: false, to: true } });
	});

	test("sends everyone without it to set it up after signing in, refusing everything else until they have", async () => {
		const member = await install.createMember({ workspaceId, role: "owner" });
		const staff = await install.createStaff({ workspaces: "all" });
		await superadminWithAuthenticator();
		await confirmIfAsked(admin, superadmin.password, () =>
			admin.api.install.security.requireTwoFactor({ required: true }),
		);

		for (const person of [member, staff]) {
			const browser = await install.signIn(person.account);
			expect((await browser.api.shell.context()).twoFactor).toEqual({
				on: false,
				required: true,
				mustSetUp: true,
				reminder: false,
			});
			await expect(browser.api.workspaces.list()).rejects.toMatchObject({
				code: "TWO_FACTOR_SETUP_REQUIRED",
				status: 403,
			});
			await expect(browser.api.members.list({ workspaceId })).rejects.toMatchObject({
				code: "TWO_FACTOR_SETUP_REQUIRED",
			});
			await expect(browser.api.me.sessions.list()).rejects.toMatchObject({ code: "TWO_FACTOR_SETUP_REQUIRED" });
			expect((await browser.api.session.current()).person?.email).toBe(person.account.email);
			expect(await browser.api.me.twoFactor.get()).toMatchObject({
				authenticator: null,
				required: true,
				requiredBy: { install: true, workspaces: [] },
			});
			await browser.api.me.updatePreferences({ adminTheme: "dark" });

			await addAuthenticator(install, browser, person.account.password);

			expect((await browser.api.shell.context()).twoFactor).toMatchObject({ on: true, mustSetUp: false });
			expect((await browser.api.workspaces.list()).workspaces.map((workspace) => workspace.id)).toContain(workspaceId);
			await browser.api.session.signOut();
		}
	});

	test("a passkey sets it up as well", async () => {
		const member = await install.createMember({ workspaceId, role: "editor" });
		await superadminWithAuthenticator();
		await confirmIfAsked(admin, superadmin.password, () =>
			admin.api.install.security.requireTwoFactor({ required: true }),
		);

		const browser = await install.signIn(member.account);
		const { options } = await browser.api.me.twoFactor.passkeyOptions();
		await browser.api.me.twoFactor.addPasskey({
			credential: await softwareAuthenticator().create(options),
			name: "Phone",
		});

		expect((await browser.api.workspaces.list()).workspaces).toHaveLength(1);
	});

	test("the last second factor can't be removed while it is required", async () => {
		const browser = await superadminWithAuthenticator();
		await confirmIfAsked(browser, superadmin.password, () =>
			browser.api.install.security.requireTwoFactor({ required: true }),
		);

		await expect(
			confirmIfAsked(browser, superadmin.password, () => browser.api.me.twoFactor.removeAuthenticator()),
		).rejects.toMatchObject({ code: "TWO_FACTOR_REQUIRED", status: 409 });

		const { options } = await browser.api.me.twoFactor.passkeyOptions();
		await browser.api.me.twoFactor.addPasskey({
			credential: await softwareAuthenticator().create(options),
			name: "Key",
		});
		await browser.api.me.twoFactor.removeAuthenticator();
		const [passkey] = (await browser.api.me.twoFactor.get()).passkeys;
		await expect(browser.api.me.twoFactor.removePasskey({ passkeyId: passkey?.id ?? "" })).rejects.toMatchObject({
			code: "TWO_FACTOR_REQUIRED",
		});
	});

	test("API tokens made before keep working: the switch is about signing in to the admin", async () => {
		const member = await install.createMember({ workspaceId, role: "editor" });
		const { secret } = await createApiToken(member.browser, { workspaceId, name: "Build script" });
		await superadminWithAuthenticator();
		await confirmIfAsked(admin, superadmin.password, () =>
			admin.api.install.security.requireTwoFactor({ required: true }),
		);

		expect((await tokenClient(install, secret).api.sites.list({ workspaceId })).sites).toEqual([]);
	});
});

describe("a Workspace's switch", () => {
	test("Owners and Staff switch it, for the Workspace's Members only: Staff follow the Install's switch", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const editor = await install.createMember({ workspaceId, role: "editor" });
		const elsewhere = await install.createMember({
			workspaceId: (await install.createWorkspace("Other")).id,
			role: "editor",
		});
		const staff = await install.createStaff({ workspaces: [workspaceId] });

		await expect(editor.browser.api.members.requireTwoFactor({ workspaceId, required: true })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(owner.browser.api.members.requireTwoFactor({ workspaceId, required: true })).rejects.toMatchObject({
			code: "TWO_FACTOR_OFF",
		});
		const { secret } = await addAuthenticator(install, owner.browser);
		const ownerBrowser = await signInWithAuthenticator(install, owner.account, secret);
		await confirmIfAsked(ownerBrowser, owner.account.password, () =>
			ownerBrowser.api.members.requireTwoFactor({ workspaceId, required: true }),
		);

		expect((await ownerBrowser.api.members.twoFactor({ workspaceId })).required).toBe(true);
		const editorBrowser = await install.signIn(editor.account);
		expect((await editorBrowser.api.shell.context()).twoFactor).toMatchObject({ required: true, mustSetUp: true });
		expect((await editorBrowser.api.me.twoFactor.get()).requiredBy).toEqual({
			install: false,
			workspaces: [{ id: workspaceId, name: "Acme" }],
		});
		await expect(editorBrowser.api.sites.list({ workspaceId })).rejects.toMatchObject({
			code: "TWO_FACTOR_SETUP_REQUIRED",
		});
		for (const free of [elsewhere, staff]) {
			const browser = await install.signIn(free.account);
			expect((await browser.api.shell.context()).twoFactor).toMatchObject({ required: false, mustSetUp: false });
		}

		await confirmIfAsked(staff.browser, staff.account.password, () =>
			staff.browser.api.members.requireTwoFactor({ workspaceId, required: false }),
		);
		expect((await editorBrowser.api.shell.context()).twoFactor).toMatchObject({ required: false, reminder: true });
		const { entries } = await admin.api.audit.list();
		expect(
			entries.filter((entry) => entry.action === "twoFactorRequirement.change").map((entry) => entry.details),
		).toEqual([
			{ from: true, to: false },
			{ from: false, to: true },
		]);
	});

	test("the Members screen shows which second factors each Member has", async () => {
		const withApp = await install.createMember({ workspaceId, role: "editor" });
		const withPasskey = await install.createMember({ workspaceId, role: "author" });
		const without = await install.createMember({ workspaceId, role: "author" });
		await addAuthenticator(install, withApp.browser);
		const { options } = await withPasskey.browser.api.me.twoFactor.passkeyOptions();
		await withPasskey.browser.api.me.twoFactor.addPasskey({
			credential: await softwareAuthenticator().create(options),
			name: "Phone",
		});

		const status = await admin.api.members.twoFactor({ workspaceId });

		expect(status.required).toBe(false);
		expect(new Map(status.members.map((member) => [member.personId, member.methods]))).toEqual(
			new Map([
				[withApp.personId, ["authenticator"]],
				[withPasskey.personId, ["passkey"]],
				[without.personId, []],
			]),
		);
		await expect(withApp.browser.api.members.twoFactor({ workspaceId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("the reminder", () => {
	test("shows to people without it until they add it, and Remind me later hides it for 7 days", async () => {
		const member = await install.createMember({ workspaceId, role: "editor" });
		expect((await member.browser.api.shell.context()).twoFactor).toEqual({
			on: false,
			required: false,
			mustSetUp: false,
			reminder: true,
		});

		await member.browser.api.me.twoFactor.remindLater();
		expect((await member.browser.api.shell.context()).twoFactor?.reminder).toBe(false);
		await install.clock.advance(6 * DAY);
		const again = await install.signIn(member.account);
		expect((await again.api.shell.context()).twoFactor?.reminder).toBe(false);
		await install.clock.advance(DAY + 1000);
		expect((await again.api.shell.context()).twoFactor?.reminder).toBe(true);

		await addAuthenticator(install, again, member.account.password);
		expect((await again.api.shell.context()).twoFactor).toMatchObject({ on: true, reminder: false });
	});

	test("signed out, there is nothing to say", async () => {
		expect((await install.browser().api.shell.context()).twoFactor).toBeNull();
	});
});
