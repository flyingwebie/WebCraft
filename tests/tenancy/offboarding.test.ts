// Offboarding: the Superadmin ends a Staff member's role, and deactivates the account of anyone who
// left (Staff or Member). Either ends the person's sessions, API tokens, AI clients, CLI sign-ins
// and the invites they sent, at once; a deactivated person can no longer sign in. Nothing they made
// is deleted: their Content and their Audit log entries stay theirs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { type CliUser, cliUser, signInCli } from "../harness/cli.ts";
import {
	createTestInstall,
	inviteLinkIn,
	type TestAccount,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";
import { approveAiClient, connectMcp } from "../harness/mcp.ts";
import { softwareAuthenticator } from "../harness/passkeys.ts";
import { addAuthenticator, confirmIfAsked, signInWithAuthenticator } from "../harness/two-factor.ts";

const MINUTE = 60 * 1000;

let install: TestInstall;
let superadmin: TestAccount;
let admin: TestBrowser;
let workspaceId: string;
let cli: CliUser;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin({ name: "Sam Superadmin" });
	admin = await install.signIn(superadmin);
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	cli = cliUser(install);
});

afterAll(async () => {
	await cli.close();
	await install.close();
});

/** Runs a Sensitive action as the Superadmin, confirming their password when asked. */
function sensitively<Result>(call: () => Promise<Result>): Promise<Result> {
	return confirmIfAsked(admin, superadmin.password, call);
}

async function tokenAnswer(secret: string) {
	const answer = await tokenClient(install, secret).request("workspaces/get", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workspaceId }),
	});
	return { status: answer.status, body: (await answer.json()) as { code?: string; data?: { problem?: string } } };
}

/** Everything a person can hold besides a session: an API token, an AI client, a CLI sign-in, an invite they sent. */
async function withEverything(person: { browser: TestBrowser; account: TestAccount }) {
	const { secret } = await createApiToken(person.browser, { workspaceId, name: "Deploy" });
	const aiClient = await approveAiClient(install, person.browser, { workspaceId });
	const signedIn = await signInCli(cli, install, person.browser, { workspaceId, sites: "all" });
	expect(signedIn.code).toBe(0);
	const invited = `invited-by-${person.account.email}`;
	await confirmIfAsked(person.browser, person.account.password, () =>
		person.browser.api.members.invite({ workspaceId, email: invited, role: "author", sites: "all" }),
	);
	const inviteToken = new URL(inviteLinkIn(await install.lastEmailTo(invited))).searchParams.get("token") ?? "";
	expect(await install.browser().api.invites.get({ token: inviteToken })).toMatchObject({ email: invited });
	return { secret, aiClient, inviteToken };
}

/** Checks that all of it stopped working. */
async function expectAllEnded(
	person: { browser: TestBrowser },
	held: Awaited<ReturnType<typeof withEverything>>,
): Promise<void> {
	expect((await person.browser.api.session.current()).person).toBeNull();
	expect(await tokenAnswer(held.secret)).toMatchObject({
		status: 401,
		body: { code: "TOKEN_INVALID", data: { problem: "revoked" } },
	});
	await expect(connectMcp(install, held.aiClient.accessToken)).rejects.toBeDefined();
	expect((await cli.run(["whoami"])).code).not.toBe(0);
	await expect(install.browser().api.invites.get({ token: held.inviteToken })).rejects.toMatchObject({
		code: "INVITE_INVALID",
	});
}

describe("what the admin offered before", () => {
	test("assigning a leaver to no Workspaces still leaves them signed in and writing the Services list", async () => {
		const leaver = await install.createStaff({ workspaces: [workspaceId] });
		await sensitively(() => admin.api.staff.setWorkspaces({ personId: leaver.personId, workspaces: [] }));

		const again = await install.signIn(leaver.account);
		await expect(again.api.servicesList.update({ services: [] })).resolves.toBeDefined();
	});
});

describe("ending a Staff role", () => {
	test("ends their sessions, API tokens, AI clients, CLI sign-ins and the invites they sent, at once", async () => {
		const leaver = await install.createStaff({ workspaces: [workspaceId], name: "Lee Leaver" });
		const held = await withEverything(leaver);

		await sensitively(() => admin.api.staff.remove({ personId: leaver.personId }));

		await expectAllEnded(leaver, held);
		expect((await admin.api.staff.list()).staff.map((person) => person.id)).not.toContain(leaver.personId);
	});

	test("leaves an account that reaches nothing: no Workspace, and the Services list is closed to them", async () => {
		const leaver = await install.createStaff({ workspaces: "all" });
		await leaver.browser.api.servicesList.update({ services: [] });
		await sensitively(() => admin.api.staff.remove({ personId: leaver.personId }));

		const again = await install.signIn(leaver.account);
		expect((await again.api.workspaces.list()).workspaces).toEqual([]);
		await expect(again.api.servicesList.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(again.api.servicesList.update({ services: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("frees the address: the person can be invited as a Member and joins with their account", async () => {
		const leaver = await install.createStaff({ workspaces: [workspaceId] });
		await expect(
			sensitively(() =>
				admin.api.members.invite({ workspaceId, email: leaver.account.email, role: "editor", sites: "all" }),
			),
		).rejects.toMatchObject({ code: "STAFF_MEMBERSHIP" });
		await sensitively(() => admin.api.staff.remove({ personId: leaver.personId }));

		await sensitively(() =>
			admin.api.members.invite({ workspaceId, email: leaver.account.email, role: "editor", sites: "all" }),
		);
		const token = new URL(inviteLinkIn(await install.lastEmailTo(leaver.account.email))).searchParams.get("token");
		const again = await install.signIn(leaver.account);
		await again.api.invites.join({ token: token ?? "" });
		expect((await again.api.workspaces.list()).workspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);
	});

	test("is recorded in the Audit log, and what they did before stays theirs", async () => {
		const leaver = await install.createStaff({ workspaces: [workspaceId], name: "Rory Recorded" });
		await leaver.browser.api.servicesList.update({ services: [{ name: "Care plan" }] });
		await withEverything(leaver);
		await sensitively(() => admin.api.staff.remove({ personId: leaver.personId }));

		const { entries, people } = await admin.api.audit.list({ limit: 50 });
		expect(entries.find((entry) => entry.action === "staff.remove")).toMatchObject({
			via: { kind: "admin" },
			details: {
				staffId: leaver.personId,
				email: leaver.account.email,
				signedOutSessions: 1,
				revokedTokens: 1,
				revokedAiClients: 2,
				withdrawnInvites: 1,
			},
		});
		// Their own entries still name them.
		expect(entries.some((entry) => entry.action === "member.invite" && entry.personId === leaver.personId)).toBe(true);
		expect(people[leaver.personId]).toMatchObject({ name: "Rory Recorded", email: leaver.account.email });
	});

	test("is the Superadmin's alone, a Sensitive action, and only for Staff: never the Superadmin or a Member", async () => {
		const staff = await install.createStaff({ workspaces: "all" });
		const other = await install.createStaff({ workspaces: "all" });
		const owner = await install.createMember({ workspaceId, role: "owner" });

		for (const browser of [staff.browser, owner.browser]) {
			await expect(browser.api.staff.remove({ personId: other.personId })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
		const superadminId = (await admin.api.session.current()).person?.id ?? "";
		for (const personId of [superadminId, owner.personId, "5f6c0ad0-8f8c-4d0e-9f6b-0a3d1c1f7e11"]) {
			await expect(sensitively(() => admin.api.staff.remove({ personId }))).rejects.toMatchObject({
				code: "STAFF_NOT_FOUND",
			});
		}

		await install.clock.advance(11 * MINUTE);
		await expect(admin.api.staff.remove({ personId: other.personId })).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
			data: { action: "staff.remove" },
		});
		expect((await other.browser.api.session.current()).person).not.toBeNull();
	});
});

describe("deactivating an account", () => {
	test("a Staff member: everything of theirs ends at once and they can no longer sign in, by password or passkey", async () => {
		const leaver = await install.createStaff({ workspaces: [workspaceId], name: "Dana Deactivated" });
		const device = softwareAuthenticator();
		const { options } = await leaver.browser.api.me.twoFactor.passkeyOptions();
		await leaver.browser.api.me.twoFactor.addPasskey({ credential: await device.create(options), name: "Laptop" });
		const held = await withEverything(leaver);

		await sensitively(() => admin.api.accounts.deactivate({ personId: leaver.personId }));

		await expectAllEnded(leaver, held);
		// Exactly like an address nobody signs in with.
		await expect(install.signIn(leaver.account)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
		const browser = install.browser();
		const passkey = await browser.api.session.passkeyOptions();
		await expect(
			browser.api.session.signInWithPasskey({ credential: await device.get(passkey.options) }),
		).rejects.toMatchObject({ code: "PASSKEY_INVALID" });
		// They stay listed, marked, so the Superadmin sees who was deactivated.
		expect((await admin.api.staff.list()).staff.find((person) => person.id === leaver.personId)).toMatchObject({
			name: "Dana Deactivated",
			deactivated: true,
		});
	});

	test("a Member: the same, and the Members list marks them", async () => {
		const leaver = await install.createMember({ workspaceId, role: "owner", name: "Mo Member" });
		const held = await withEverything(leaver);

		await sensitively(() => admin.api.accounts.deactivate({ personId: leaver.personId }));

		await expectAllEnded(leaver, held);
		await expect(install.signIn(leaver.account)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
		const { members } = await admin.api.members.list({ workspaceId });
		expect(members.find((member) => member.id === leaver.personId)).toMatchObject({ deactivated: true });
		expect(members.filter((member) => member.id !== leaver.personId).every((member) => !member.deactivated)).toBe(true);
	});

	test("a reset link they were sent before stops working, and no new one or System email goes to them", async () => {
		const leaver = await install.createMember({ workspaceId, role: "editor" });
		await install.browser().api.passwordReset.request({ email: leaver.account.email });
		const sent = (await install.lastEmailTo(leaver.account.email)).text;
		const token = new URL(sent.match(/https?:\/\/\S+/)?.[0] ?? "").searchParams.get("token") ?? "";
		await install.browser().api.passwordReset.check({ token });

		await sensitively(() => admin.api.accounts.deactivate({ personId: leaver.personId }));
		await expect(install.browser().api.passwordReset.check({ token })).rejects.toMatchObject({
			code: "PASSWORD_RESET_INVALID",
		});
		const before = (await install.lastEmailTo(leaver.account.email)).subject;

		await install.browser().api.passwordReset.request({ email: leaver.account.email });
		await install.drainJobs();
		expect(
			await install.sendSystemEmail({
				type: "two-factor-reset",
				to: { personId: leaver.personId },
				data: { resetBy: "Sam Superadmin" },
			}),
		).toEqual([]);
		expect((await install.lastEmailTo(leaver.account.email)).subject).toBe(before);
	});

	test("nobody acts as a deactivated person: impersonating them is refused", async () => {
		const leaver = await install.createMember({ workspaceId, role: "editor" });
		const helper = await install.createStaff({ workspaces: [workspaceId] });
		const { secret } = await addAuthenticator(install, helper.browser);
		await sensitively(() => admin.api.accounts.deactivate({ personId: leaver.personId }));

		const staff = await signInWithAuthenticator(install, helper.account, secret);
		await expect(staff.api.impersonation.start({ personId: leaver.personId })).rejects.toMatchObject({
			code: "PERSON_NOT_FOUND",
		});
	});

	test("is recorded in the Audit log, and what they did before stays theirs", async () => {
		const leaver = await install.createMember({ workspaceId, role: "owner", name: "Ada Attributed" });
		await withEverything(leaver);
		await sensitively(() => admin.api.accounts.deactivate({ personId: leaver.personId }));

		const { entries, people } = await admin.api.audit.list({ limit: 50 });
		expect(entries.find((entry) => entry.action === "account.deactivate")).toMatchObject({
			via: { kind: "admin" },
			workspaceId: null,
			details: {
				personId: leaver.personId,
				email: leaver.account.email,
				signedOutSessions: 1,
				revokedTokens: 1,
				revokedAiClients: 2,
				withdrawnInvites: 1,
			},
		});
		expect(entries.some((entry) => entry.action === "member.invite" && entry.personId === leaver.personId)).toBe(true);
		expect(people[leaver.personId]).toMatchObject({ name: "Ada Attributed", email: leaver.account.email });
	});

	test("the last Superadmin can't be deactivated, nor anyone by themselves; an unknown person is refused", async () => {
		const superadminId = (await admin.api.session.current()).person?.id ?? "";
		await expect(sensitively(() => admin.api.accounts.deactivate({ personId: superadminId }))).rejects.toMatchObject({
			code: "ACCOUNT_DEACTIVATION_REFUSED",
			status: 409,
			data: { reason: "lastSuperadmin" },
		});
		expect((await admin.api.session.current()).person).not.toBeNull();
		await expect(
			sensitively(() => admin.api.accounts.deactivate({ personId: "5f6c0ad0-8f8c-4d0e-9f6b-0a3d1c1f7e11" })),
		).rejects.toMatchObject({ code: "PERSON_NOT_FOUND" });
	});

	test("is the Superadmin's alone and a Sensitive action", async () => {
		const staff = await install.createStaff({ workspaces: "all" });
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const member = await install.createMember({ workspaceId, role: "author" });

		for (const browser of [staff.browser, owner.browser]) {
			for (const call of ["deactivate", "reactivate"] as const) {
				await expect(browser.api.accounts[call]({ personId: member.personId })).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
			}
		}
		await install.clock.advance(11 * MINUTE);
		await expect(admin.api.accounts.deactivate({ personId: member.personId })).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
			data: { action: "account.deactivate" },
		});
		expect((await member.browser.api.session.current()).person).not.toBeNull();
	});

	test("reactivating lets them sign in again with what they had: password, second factor and role; ended tokens stay ended", async () => {
		const leaver = await install.createStaff({ workspaces: [workspaceId] });
		const { secret } = await addAuthenticator(install, leaver.browser);
		const token = await createApiToken(leaver.browser, { workspaceId, name: "Deploy" });
		await sensitively(() => admin.api.accounts.deactivate({ personId: leaver.personId }));

		await sensitively(() => admin.api.accounts.reactivate({ personId: leaver.personId }));

		const back = await signInWithAuthenticator(install, leaver.account, secret);
		expect((await back.api.workspaces.list()).workspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);
		expect(await tokenAnswer(token.secret)).toMatchObject({ status: 401 });
		expect((await admin.api.staff.list()).staff.find((person) => person.id === leaver.personId)).toMatchObject({
			deactivated: false,
		});
		const { entries } = await admin.api.audit.list({ limit: 10 });
		expect(entries.find((entry) => entry.action === "account.reactivate")).toMatchObject({
			details: { personId: leaver.personId, email: leaver.account.email },
		});
	});
});
