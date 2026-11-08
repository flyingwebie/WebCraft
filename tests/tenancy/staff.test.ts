// Staff: the agency's people. The Superadmin invites them by email and assigns them to some or all
// Workspaces; Staff reach Workspaces only by assignment, never through a Membership (ADR 0001).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	createTestInstall,
	inviteLinkIn,
	TEST_PASSWORD,
	type TestAccount,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";

const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;
let superadmin: TestAccount;
let admin: TestBrowser;
let acme: { id: string; name: string };
let nimbus: { id: string; name: string };

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin({ name: "Sam Superadmin" });
	admin = await install.signIn(superadmin);
	await admin.api.install.settings.update({ name: "Northwind Studio" });
	await admin.api.install.smtp.update({
		host: "smtp.agency.example",
		port: 587,
		security: "starttls",
		username: "mailer@agency.example",
		fromAddress: "noreply@agency.example",
		replyTo: null,
		password: "the smtp password 9x8y",
	});
	const created = async (name: string) => {
		const { workspace } = await admin.api.workspaces.create({ name });
		return { id: workspace.id, name: workspace.name };
	};
	acme = await created("Acme Ltd");
	nimbus = await created("Nimbus Bikes");
});

afterAll(async () => {
	await install.close();
});

/** Accepts the invite in the newest email to `email` with a fresh browser, and answers the browser. */
async function accept(email: string, name = "Ciara Staff"): Promise<TestBrowser> {
	const browser = install.browser();
	const token = await tokenFor(email);
	await browser.api.invites.accept({ token, name, password: TEST_PASSWORD, adminLanguage: "en" });
	return browser;
}

/** The token of the invite link in the newest email to `email`. */
async function tokenFor(email: string): Promise<string> {
	return new URL(inviteLinkIn(await install.lastEmailTo(email))).searchParams.get("token") ?? "";
}

describe("inviting Staff", () => {
	test("the Superadmin invites Staff to chosen Workspaces, and an email with a link valid for 7 days goes out", async () => {
		await install.drainJobs();
		install.mail.clear();

		const { invite } = await admin.api.staff.invite({ email: " Ciara@Agency.example ", workspaces: [acme.id] });
		await install.drainJobs();

		expect(invite).toEqual({
			id: expect.any(String),
			email: "ciara@agency.example",
			workspaces: [acme],
			invitedBy: { id: expect.any(String), name: "Sam Superadmin" },
			createdAt: install.clock.now(),
			expiresAt: new Date(install.clock.now().getTime() + 7 * DAY),
		});
		expect(install.mail.sent).toHaveLength(1);
		const [email] = install.mail.sent;
		expect(email?.to).toBe("ciara@agency.example");
		expect(email?.subject).toBe("Sam Superadmin invited you to Northwind Studio");
		expect(email?.text).toContain("Sam Superadmin invited you to join Northwind Studio as Staff.");
		expect(email?.text).toContain("The invite works for 7 days.");
		expect(inviteLinkIn(email)).toStartWith(install.adminUrl("/invite?token="));
	});

	test("the invite link shows who invited whom, and accepting it creates the account and signs them in as Staff", async () => {
		await admin.api.staff.invite({ email: "aoife@agency.example", workspaces: [acme.id, nimbus.id] });
		const browser = install.browser();

		expect(await browser.api.invites.get({ token: await tokenFor("aoife@agency.example") })).toEqual({
			email: "aoife@agency.example",
			role: "staff",
			installName: "Northwind Studio",
			invitedBy: "Sam Superadmin",
			expiresAt: new Date(install.clock.now().getTime() + 7 * DAY),
			workspace: null,
			hasAccount: false,
		});

		await browser.api.invites.accept({
			token: await tokenFor("aoife@agency.example"),
			name: "Aoife Kelly",
			password: TEST_PASSWORD,
			adminLanguage: "it",
		});

		expect((await browser.api.shell.context()).person).toMatchObject({
			name: "Aoife Kelly",
			email: "aoife@agency.example",
			installRole: "staff",
			adminLanguage: "it",
		});
		const again = await install.signIn({ email: "aoife@agency.example", password: TEST_PASSWORD });
		expect((await again.api.session.current()).person?.installRole).toBe("staff");
	});

	test("Staff see only the Workspaces they are assigned to", async () => {
		await admin.api.staff.invite({ email: "tom@agency.example", workspaces: [nimbus.id] });
		const staff = await accept("tom@agency.example", "Tom Byrne");

		const { workspaces } = await staff.api.workspaces.list();

		expect(workspaces.map((workspace) => workspace.name)).toEqual(["Nimbus Bikes"]);
		await expect(staff.api.workspaces.get({ workspaceId: acme.id })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
		expect((await staff.api.workspaces.get({ workspaceId: nimbus.id })).workspace.name).toBe("Nimbus Bikes");
	});

	test("Staff assigned to all Workspaces also reach Workspaces created later", async () => {
		await admin.api.staff.invite({ email: "all@agency.example", workspaces: "all" });
		const staff = await accept("all@agency.example", "Alex Everywhere");

		const { workspace: later } = await admin.api.workspaces.create({ name: "Verde Travel" });

		const names = (await staff.api.workspaces.list()).workspaces.map((workspace) => workspace.name);
		expect(names).toEqual(expect.arrayContaining(["Acme Ltd", "Nimbus Bikes", "Verde Travel"]));
		expect((await staff.api.workspaces.get({ workspaceId: later.id })).workspace.name).toBe("Verde Travel");
	});

	test("the Workspaces list shows which Staff are assigned to each Workspace", async () => {
		await admin.api.staff.invite({ email: "list@agency.example", workspaces: [acme.id] });
		await accept("list@agency.example", "Lee List");

		const { workspaces } = await admin.api.workspaces.list();

		const staffOf = (id: string) => workspaces.find((workspace) => workspace.id === id)?.staff.map((s) => s.name);
		expect(staffOf(acme.id)).toContain("Lee List");
		expect(staffOf(acme.id)).toContain("Alex Everywhere");
		expect(staffOf(nimbus.id)).not.toContain("Lee List");
	});

	test("refuses Workspaces that don't exist", async () => {
		await expect(
			admin.api.staff.invite({ email: "ghost@agency.example", workspaces: [crypto.randomUUID()] }),
		).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
	});

	test("refuses to invite someone who already has an account: Staff never hold a Membership", async () => {
		await expect(admin.api.staff.invite({ email: superadmin.email, workspaces: "all" })).rejects.toMatchObject({
			code: "EMAIL_IN_USE",
		});
	});

	test("refuses a malformed email address", async () => {
		await expect(admin.api.staff.invite({ email: "not an email", workspaces: "all" })).rejects.toMatchObject({
			code: "EMAIL_INVALID",
		});
	});
});

describe("invite links", () => {
	test("work once", async () => {
		await admin.api.staff.invite({ email: "once@agency.example", workspaces: [acme.id] });
		const token = await tokenFor("once@agency.example");
		await accept("once@agency.example");

		await expect(install.browser().api.invites.get({ token })).rejects.toMatchObject({ code: "INVITE_INVALID" });
		await expect(
			install.browser().api.invites.accept({ token, name: "Twice", password: TEST_PASSWORD, adminLanguage: "en" }),
		).rejects.toMatchObject({ code: "INVITE_INVALID" });
	});

	test("stop working after 7 days", async () => {
		await admin.api.staff.invite({ email: "late@agency.example", workspaces: [acme.id] });
		const token = await tokenFor("late@agency.example");

		await install.clock.advance(7 * DAY + 1000);
		// A week unused also ends the Superadmin's session.
		admin = await install.signIn(superadmin);

		await expect(install.browser().api.invites.get({ token })).rejects.toMatchObject({ code: "INVITE_INVALID" });
		await expect(
			install.browser().api.invites.accept({ token, name: "Late", password: TEST_PASSWORD, adminLanguage: "en" }),
		).rejects.toMatchObject({ code: "INVITE_INVALID" });
	});

	test("inviting the same address again sends a new link and the earlier one stops working", async () => {
		await admin.api.staff.invite({ email: "again@agency.example", workspaces: [acme.id] });
		const first = await tokenFor("again@agency.example");

		await admin.api.staff.invite({ email: "again@agency.example", workspaces: [nimbus.id] });

		await expect(install.browser().api.invites.get({ token: first })).rejects.toMatchObject({
			code: "INVITE_INVALID",
		});
		const staff = await accept("again@agency.example");
		expect((await staff.api.workspaces.list()).workspaces.map((workspace) => workspace.name)).toEqual(["Nimbus Bikes"]);
		const { invites } = await admin.api.staff.list();
		expect(invites.filter((invite) => invite.email === "again@agency.example")).toEqual([]);
	});

	test("a revoked invite's link stops working", async () => {
		const { invite } = await admin.api.staff.invite({ email: "revoked@agency.example", workspaces: [acme.id] });
		const token = await tokenFor("revoked@agency.example");

		await admin.api.staff.revokeInvite({ inviteId: invite.id });

		await expect(install.browser().api.invites.get({ token })).rejects.toMatchObject({ code: "INVITE_INVALID" });
		expect((await admin.api.staff.list()).invites.map((pending) => pending.email)).not.toContain(
			"revoked@agency.example",
		);
	});

	test("refuses a password the rules don't allow, and the link keeps working", async () => {
		await admin.api.staff.invite({ email: "short@agency.example", workspaces: [acme.id] });
		const token = await tokenFor("short@agency.example");

		await expect(
			install.browser().api.invites.accept({ token, name: "Short", password: "too short", adminLanguage: "en" }),
		).rejects.toMatchObject({ code: "PASSWORD_REFUSED" });

		expect((await install.browser().api.invites.get({ token })).email).toBe("short@agency.example");
	});
});

describe("a Staff invite to an address that got an account meanwhile", () => {
	/** A Staff invite to `email`, then the same address joins Acme as a Member through a Member invite. */
	async function staffInviteThenMembership(email: string) {
		await admin.api.session.confirmIdentity({ password: superadmin.password });
		await admin.api.staff.invite({ email, workspaces: "all" });
		const staffToken = await tokenFor(email);
		await admin.api.members.invite({ workspaceId: acme.id, email, role: "author", sites: "all" });
		const member = install.browser();
		const { personId } = await member.api.invites.accept({
			token: await tokenFor(email),
			name: "Dual Person",
			password: TEST_PASSWORD,
			adminLanguage: "en",
		});
		return { staffToken, personId, member };
	}

	test("is refused when the account holds a Membership: Staff never do", async () => {
		const { staffToken, member } = await staffInviteThenMembership("dual@agency.example");

		expect((await member.api.invites.get({ token: staffToken })).hasAccount).toBe(true);
		await expect(member.api.invites.join({ token: staffToken })).rejects.toMatchObject({ code: "STAFF_MEMBERSHIP" });
		expect((await member.api.session.current()).person?.installRole ?? null).toBeNull();
	});

	test("makes the account Staff when it holds no Membership any more", async () => {
		const { staffToken, personId, member } = await staffInviteThenMembership("former@agency.example");
		await admin.api.session.confirmIdentity({ password: superadmin.password });
		await admin.api.members.remove({ workspaceId: acme.id, personId });

		const { workspaceId } = await member.api.invites.join({ token: staffToken });

		expect(workspaceId).toBeNull();
		expect((await member.api.session.current()).person?.installRole).toBe("staff");
		await expect(member.api.invites.get({ token: staffToken })).rejects.toMatchObject({ code: "INVITE_INVALID" });
	});
});

describe("the Staff list", () => {
	test("shows Staff with the Workspaces they reach, and pending invites", async () => {
		await admin.api.staff.invite({ email: "pending@agency.example", workspaces: [nimbus.id] });

		const { staff, invites } = await admin.api.staff.list();

		expect(staff).toContainEqual({
			id: expect.any(String),
			name: "Tom Byrne",
			email: "tom@agency.example",
			workspaces: [nimbus],
			since: expect.any(Date),
		});
		expect(staff).toContainEqual(expect.objectContaining({ name: "Alex Everywhere", workspaces: "all" }));
		expect(staff.map((person) => person.email)).not.toContain(superadmin.email);
		expect(invites).toContainEqual(expect.objectContaining({ email: "pending@agency.example", workspaces: [nimbus] }));
	});
});

describe("changing which Workspaces Staff reach", () => {
	test("takes effect on their next request", async () => {
		await admin.api.staff.invite({ email: "moved@agency.example", workspaces: [acme.id] });
		const staff = await accept("moved@agency.example", "Morgan Moved");
		const person = (await staff.api.session.current()).person;
		if (!person) throw new Error("Not signed in.");

		await admin.api.staff.setWorkspaces({ personId: person.id, workspaces: [nimbus.id] });

		expect((await staff.api.workspaces.list()).workspaces.map((workspace) => workspace.name)).toEqual(["Nimbus Bikes"]);
		await expect(staff.api.workspaces.get({ workspaceId: acme.id })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});

		await admin.api.staff.setWorkspaces({ personId: person.id, workspaces: "all" });

		expect((await staff.api.workspaces.get({ workspaceId: acme.id })).workspace.name).toBe("Acme Ltd");
	});

	test("refuses someone who isn't Staff", async () => {
		const { person } = await admin.api.session.current();

		await expect(
			admin.api.staff.setWorkspaces({ personId: person?.id ?? "", workspaces: [acme.id] }),
		).rejects.toMatchObject({ code: "STAFF_NOT_FOUND" });
	});
});

describe("who can manage Staff", () => {
	test("Staff can't invite Staff, list them, revoke invites or change assignments", async () => {
		await admin.api.staff.invite({ email: "eager@agency.example", workspaces: "all" });
		const staff = await accept("eager@agency.example", "Eager Staff");
		const { invite } = await admin.api.staff.invite({ email: "target@agency.example", workspaces: [acme.id] });
		const target = (await staff.api.session.current()).person?.id ?? "";

		await expect(staff.api.staff.invite({ email: "friend@agency.example", workspaces: "all" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(staff.api.staff.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(staff.api.staff.revokeInvite({ inviteId: invite.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(staff.api.staff.setWorkspaces({ personId: target, workspaces: "all" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(staff.api.workspaces.create({ name: "Rogue Ltd" })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("people who aren't signed in can't manage Staff", async () => {
		await expect(install.browser().api.staff.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("the Audit log", () => {
	test("records invites, joining, revoking and changed assignments, with who, when and how", async () => {
		const { person: me } = await admin.api.session.current();
		const { invite } = await admin.api.staff.invite({ email: "audit@agency.example", workspaces: [acme.id] });
		// Sent now: two emails queued in the same instant could go out in either order.
		await install.drainJobs();
		await admin.api.staff.revokeInvite({ inviteId: invite.id });
		await admin.api.staff.invite({ email: "audit@agency.example", workspaces: [acme.id] });
		const staff = await accept("audit@agency.example", "Audrey Audit");
		const joined = (await staff.api.session.current()).person?.id;
		await admin.api.staff.setWorkspaces({ personId: joined ?? "", workspaces: "all" });

		const { entries } = await admin.api.audit.list({ limit: 4 });

		const common = { via: { kind: "admin" } as const, at: install.clock.now(), workspaceId: null, siteId: null };
		expect(entries.reverse()).toEqual([
			{
				...common,
				id: expect.any(String),
				action: "staff.revokeInvite",
				personId: me?.id ?? null,
				details: { email: "audit@agency.example" },
			},
			{
				...common,
				id: expect.any(String),
				action: "staff.invite",
				personId: me?.id ?? null,
				details: { email: "audit@agency.example", workspaces: [acme.id] },
			},
			{
				...common,
				id: expect.any(String),
				action: "staff.join",
				personId: joined ?? null,
				details: { email: "audit@agency.example", workspaces: [acme.id] },
			},
			{
				...common,
				id: expect.any(String),
				action: "staff.changeWorkspaces",
				personId: me?.id ?? null,
				details: { staffId: joined, workspaces: "all" },
			},
		]);
	});
});
