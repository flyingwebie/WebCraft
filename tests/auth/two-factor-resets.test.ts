// Recovering two-factor authentication someone lost: the Superadmin resets anyone's, Staff reset
// their Workspaces' Members' (never other Staff or the Superadmin). Each reset is a Sensitive
// action, emailed to the person and recorded in the Audit log.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import type { TestBrowser } from "../harness/browser.ts";
import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";
import { approveAiClient, connectMcp } from "../harness/mcp.ts";
import { softwareAuthenticator } from "../harness/passkeys.ts";
import { addAuthenticator, confirmIfAsked, signInWithAuthenticator } from "../harness/two-factor.ts";

const MINUTE = 60_000;

let install: TestInstall;
let superadmin: TestAccount;
let admin: TestBrowser;
let workspaceId: string;
let otherWorkspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin({ name: "Sam Superadmin" });
	workspaceId = (await install.createWorkspace("Acme")).id;
	otherWorkspaceId = (await install.createWorkspace("Other")).id;
	admin = await install.superadmin();
});

afterAll(async () => {
	await install.close();
});

/** A Member of `workspace` with an authenticator app and a passkey, signed in on two browsers. */
async function memberWithTwoFactor(workspace = workspaceId) {
	const member = await install.createMember({ workspaceId: workspace, role: "editor" });
	const { secret } = await addAuthenticator(install, member.browser);
	const { options } = await member.browser.api.me.twoFactor.passkeyOptions();
	await member.browser.api.me.twoFactor.addPasskey({
		credential: await softwareAuthenticator().create(options),
		name: "Phone",
	});
	const laptop = await signInWithAuthenticator(install, member.account, secret);
	return { ...member, account: member.account as TestAccount, secret, laptop };
}

describe("a Member's reset", () => {
	// A reset answers "someone may have had this account": what they could have made with it, a
	// token or an AI client that acts as the person, ends too (the report's A1-7).
	test("ends the person's API tokens and AI clients with their sessions, and says so", async () => {
		const member = await memberWithTwoFactor();
		const { secret } = await createApiToken(member.browser, { workspaceId, name: "Left behind" });
		const client = await approveAiClient(install, member.browser, { workspaceId });
		await tokenClient(install, secret).api.workspaces.get({ workspaceId });

		await confirmIfAsked(admin, superadmin.password, () =>
			admin.api.members.resetTwoFactor({ workspaceId, personId: member.personId }),
		);

		await expect(tokenClient(install, secret).api.workspaces.get({ workspaceId })).rejects.toMatchObject({
			code: "TOKEN_INVALID",
			data: { problem: "revoked" },
		});
		await expect(connectMcp(install, client.accessToken)).rejects.toBeDefined();
		const { entries } = await admin.api.audit.list({ limit: 20 });
		expect(
			entries.find((found) => found.action === "twoFactor.reset" && found.details.personId === member.personId),
		).toMatchObject({ details: { revokedTokens: 1, revokedAiClients: 1 } });
		expect(entries.find((found) => found.action === "apiToken.revoke")).toMatchObject({
			details: { name: "Left behind", owner: member.personId, reason: "reset" },
		});
		expect((await install.lastEmailTo(member.account.email)).text).toContain("API tokens and AI clients");
	});

	test("by the Superadmin: every second factor goes, every session ends, they are emailed and it is logged", async () => {
		const member = await memberWithTwoFactor();

		await confirmIfAsked(admin, superadmin.password, () =>
			admin.api.members.resetTwoFactor({ workspaceId, personId: member.personId }),
		);

		expect((await member.laptop.api.session.current()).person).toBeNull();
		expect((await member.browser.api.session.current()).person).toBeNull();
		const email = await install.lastEmailTo(member.account.email);
		expect(email.subject).toBe("Your two-factor authentication was reset");
		expect(email.text).toContain("Sam Superadmin reset the two-factor authentication of your account");
		const browser = install.browser();
		expect(await browser.api.session.signIn(member.account)).toMatchObject({
			person: { id: member.personId },
			secondStep: null,
		});
		expect(await browser.api.me.twoFactor.get()).toMatchObject({
			authenticator: null,
			passkeys: [],
			backupCodes: { left: 0 },
		});
		const entry = (await admin.api.audit.list()).entries.find(
			(found) => found.action === "twoFactor.reset" && found.details.personId === member.personId,
		);
		expect(entry).toMatchObject({
			personId: (await admin.api.session.current()).person?.id,
			workspaceId,
			details: {
				personId: member.personId,
				email: member.account.email,
				authenticator: true,
				passkeys: 1,
				signedOutSessions: 2,
			},
		});
	});

	test("by Staff of the Workspace, never for a Member of a Workspace they don't reach", async () => {
		const staff = await install.createStaff({ workspaces: [workspaceId] });
		const member = await memberWithTwoFactor();
		const elsewhere = await memberWithTwoFactor(otherWorkspaceId);

		await staff.browser.api.members.resetTwoFactor({ workspaceId, personId: member.personId });
		expect((await install.lastEmailTo(member.account.email)).text).toContain(`${staff.account.name} reset`);

		await expect(
			staff.browser.api.members.resetTwoFactor({ workspaceId: otherWorkspaceId, personId: elsewhere.personId }),
		).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
		await expect(
			staff.browser.api.members.resetTwoFactor({ workspaceId, personId: elsewhere.personId }),
		).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
		expect((await elsewhere.laptop.api.session.current()).person).not.toBeNull();
	});

	test("never another Staff member or the Superadmin, and never by an Owner or Editor", async () => {
		const staff = await install.createStaff({ workspaces: [workspaceId] });
		const colleague = await install.createStaff({ workspaces: [workspaceId] });
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const member = await memberWithTwoFactor();
		const superadminId = (await admin.api.session.current()).person?.id ?? "";

		for (const personId of [colleague.personId, superadminId]) {
			await expect(staff.browser.api.members.resetTwoFactor({ workspaceId, personId })).rejects.toMatchObject({
				code: "MEMBER_NOT_FOUND",
			});
		}
		await expect(staff.browser.api.staff.resetTwoFactor({ personId: colleague.personId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			owner.browser.api.members.resetTwoFactor({ workspaceId, personId: member.personId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("is a Sensitive action", async () => {
		const staff = await install.createStaff({ workspaces: [workspaceId] });
		const member = await memberWithTwoFactor();
		await install.clock.advance(11 * MINUTE);

		await expect(
			staff.browser.api.members.resetTwoFactor({ workspaceId, personId: member.personId }),
		).rejects.toMatchObject({ code: "IDENTITY_CHECK_REQUIRED", data: { action: "twoFactor.reset" } });
	});

	test("lifts a lock wrong codes put on the second step", async () => {
		const member = await memberWithTwoFactor();
		// Two browsers, five wrong codes each, so no address reaches its limit of requests a minute.
		for (let round = 0; round < 2; round++) {
			const browser = install.browser();
			await browser.api.session.signIn(member.account);
			for (let attempt = 0; attempt < 5; attempt++) {
				await browser.api.session.secondStep({ method: "authenticator", code: "000000" }).catch(() => undefined);
			}
		}
		const locked = install.browser();
		await locked.api.session.signIn(member.account);
		await expect(locked.api.session.secondStep({ method: "authenticator", code: "000000" })).rejects.toMatchObject({
			code: "ACCOUNT_LOCKED",
		});

		await confirmIfAsked(admin, superadmin.password, () =>
			admin.api.members.resetTwoFactor({ workspaceId, personId: member.personId }),
		);

		expect((await install.browser().api.session.signIn(member.account)).person?.id).toBe(member.personId);
	});
});

describe("a Staff member's reset", () => {
	test("by the Superadmin, from the Staff screen", async () => {
		const staff = await install.createStaff({ workspaces: "all" });
		const { secret } = await addAuthenticator(install, staff.browser);
		await signInWithAuthenticator(install, staff.account, secret);

		await confirmIfAsked(admin, superadmin.password, () =>
			admin.api.staff.resetTwoFactor({ personId: staff.personId }),
		);

		expect((await install.lastEmailTo(staff.account.email)).subject).toBe("Your two-factor authentication was reset");
		expect((await install.browser().api.session.signIn(staff.account)).secondStep).toBeNull();
		const entry = (await admin.api.audit.list()).entries.find(
			(found) => found.action === "twoFactor.reset" && found.details.personId === staff.personId,
		);
		expect(entry).toMatchObject({ workspaceId: null, details: { email: staff.account.email } });
	});

	test("only Staff: a Member or the Superadmin is not one", async () => {
		const member = await install.createMember({ workspaceId, role: "editor" });
		const superadminId = (await admin.api.session.current()).person?.id ?? "";

		for (const personId of [member.personId, superadminId]) {
			await expect(
				confirmIfAsked(admin, superadmin.password, () => admin.api.staff.resetTwoFactor({ personId })),
			).rejects.toMatchObject({ code: "STAFF_NOT_FOUND" });
		}
	});
});
