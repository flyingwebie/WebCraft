// Member invites: Staff and Owners invite client people into a Workspace as Owner, Editor or Author,
// reaching all its Sites or chosen ones. The invite is a System email with a link that works once
// for 7 days; accepting it creates the account, or adds a Membership to the person's existing one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	createTestInstall,
	inviteLinkIn,
	TEST_PASSWORD,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";

const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;
let admin: TestBrowser;
let acme: { id: string; name: string };
let bakery: { id: string; slug: string };
let careers: { id: string; slug: string };
let staff: { browser: TestBrowser; personId: string };

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	await admin.api.install.settings.update({ name: "Northwind Studio" });
	acme = await install.createWorkspace("Acme Ltd");
	bakery = await install.createSite(acme.id, { name: "Acme Bakery", slug: "bakery" });
	careers = await install.createSite(acme.id, { name: "Acme Careers", slug: "careers" });
	staff = await install.createStaff({ workspaces: [acme.id], name: "Ciara Byrne" });
});

afterAll(async () => {
	await install.close();
});

/** The token of the invite link in the newest email to `email`. */
async function tokenFor(email: string): Promise<string> {
	return new URL(inviteLinkIn(await install.lastEmailTo(email))).searchParams.get("token") ?? "";
}

describe("inviting a Member", () => {
	test("Staff invite a Member to chosen Sites, and a System email with a link valid for 7 days goes out", async () => {
		const { invite } = await staff.browser.api.members.invite({
			workspaceId: acme.id,
			email: " Niamh@AcmeLtd.example ",
			role: "editor",
			sites: [bakery.id],
		});

		expect(invite).toEqual({
			id: expect.any(String),
			email: "niamh@acmeltd.example",
			role: "editor",
			sites: [{ id: bakery.id, name: "Acme Bakery" }],
			otherSites: 0,
			invitedBy: { id: staff.personId, name: "Ciara Byrne" },
			createdAt: install.clock.now(),
			expiresAt: new Date(install.clock.now().getTime() + 7 * DAY),
			manageable: true,
		});
		const email = await install.lastEmailTo("niamh@acmeltd.example");
		expect(email.subject).toBe("Ciara Byrne invited you to Acme Ltd");
		expect(email.text).toContain("Ciara Byrne invited you to Acme Ltd on Northwind Studio, as an Editor.");
		expect(email.text).toContain("The invite works for 7 days.");
		expect(inviteLinkIn(email)).toStartWith(install.adminUrl("/invite?token="));
	});
});

describe("accepting a Member invite", () => {
	test("the link shows the Workspace and role; accepting creates the account with the Membership and signs them in", async () => {
		await staff.browser.api.members.invite({
			workspaceId: acme.id,
			email: "giulia@acmeltd.example",
			role: "editor",
			sites: [bakery.id],
		});
		const token = await tokenFor("giulia@acmeltd.example");
		const browser = install.browser();

		expect(await browser.api.invites.get({ token })).toEqual({
			email: "giulia@acmeltd.example",
			role: "editor",
			installName: "Northwind Studio",
			invitedBy: "Ciara Byrne",
			expiresAt: new Date(install.clock.now().getTime() + 7 * DAY),
			workspace: { name: "Acme Ltd" },
			hasAccount: false,
		});

		expect(
			await browser.api.invites.accept({ token, name: "Giulia Romano", password: TEST_PASSWORD, adminLanguage: "it" }),
		).toEqual({ personId: expect.any(String), workspaceId: acme.id });

		expect((await browser.api.session.current()).person).toMatchObject({
			name: "Giulia Romano",
			email: "giulia@acmeltd.example",
			installRole: null,
			adminLanguage: "it",
		});
		expect((await browser.api.workspaces.list()).workspaces.map((workspace) => workspace.name)).toEqual(["Acme Ltd"]);
		expect((await browser.api.sites.get({ siteId: bakery.id })).permissions).toEqual([
			"site.view",
			"entry.edit",
			"entry.publish",
			"entry.delete",
			"media.upload",
		]);
		await expect(browser.api.sites.get({ siteId: careers.id })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
	});

	test("refuses a password shorter than 12 characters, and the link keeps working", async () => {
		await staff.browser.api.members.invite({
			workspaceId: acme.id,
			email: "short@acmeltd.example",
			role: "author",
			sites: "all",
		});
		const token = await tokenFor("short@acmeltd.example");

		await expect(
			install.browser().api.invites.accept({ token, name: "Short", password: "elevenchars", adminLanguage: "en" }),
		).rejects.toMatchObject({ code: "PASSWORD_REFUSED" });

		expect((await install.browser().api.invites.get({ token })).email).toBe("short@acmeltd.example");
	});

	test("one person holds Memberships in several Workspaces with one account: they sign in and join", async () => {
		const nimbus = await install.createWorkspace("Nimbus Bikes");
		const { account, browser } = await install.createMember({ workspaceId: acme.id, role: "author" });
		await browser.api.me.updatePreferences({ adminLanguage: "it" });

		await admin.api.members.invite({ workspaceId: nimbus.id, email: account.email, role: "owner", sites: "all" });
		const email = await install.lastEmailTo(account.email);
		const token = new URL(inviteLinkIn(email)).searchParams.get("token") ?? "";

		// In the invitee's own Admin language.
		expect(email.subject).toBe("Sam Superadmin ti ha invitato in Nimbus Bikes");
		expect((await install.browser().api.invites.get({ token })).hasAccount).toBe(true);
		await expect(
			install.browser().api.invites.accept({ token, name: "Twin", password: TEST_PASSWORD, adminLanguage: "en" }),
		).rejects.toMatchObject({ code: "EMAIL_IN_USE" });

		expect(await browser.api.invites.join({ token })).toEqual({ workspaceId: nimbus.id });

		const names = (await browser.api.workspaces.list()).workspaces.map((workspace) => workspace.name);
		expect(names).toEqual(["Acme Ltd", "Nimbus Bikes"]);
		expect((await browser.api.workspaces.get({ workspaceId: nimbus.id })).permissions).toContain("member.invite");
		expect((await browser.api.workspaces.get({ workspaceId: acme.id })).permissions).not.toContain("member.invite");
		await expect(browser.api.invites.join({ token })).rejects.toMatchObject({ code: "INVITE_INVALID" });
	});

	test("joining needs the account the invite was sent to", async () => {
		const { account } = await install.createMember({ workspaceId: acme.id, role: "author" });
		const nimbus = await install.createWorkspace("Nimbus Two");
		await admin.api.members.invite({ workspaceId: nimbus.id, email: account.email, role: "editor", sites: "all" });
		const token = await tokenFor(account.email);
		const someoneElse = await install.createMember({ workspaceId: acme.id, role: "editor" });

		await expect(someoneElse.browser.api.invites.join({ token })).rejects.toMatchObject({
			code: "INVITE_OTHER_ACCOUNT",
		});
		await expect(install.browser().api.invites.join({ token })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect((await install.browser().api.invites.get({ token })).email).toBe(account.email);
	});
});

describe("who may invite, and what they may grant", () => {
	test("Owners invite Owners, Editors and Authors", async () => {
		const owner = await install.createMember({ workspaceId: acme.id, role: "owner" });

		for (const role of ["owner", "editor", "author"] as const) {
			const { invite } = await owner.browser.api.members.invite({
				workspaceId: acme.id,
				email: `${role}-by-owner@acmeltd.example`,
				role,
				sites: "all",
			});
			expect(invite).toMatchObject({ role, sites: "all", invitedBy: { id: owner.personId } });
		}
	});

	test("Editors and Authors can't invite", async () => {
		for (const role of ["editor", "author"] as const) {
			const { browser } = await install.createMember({ workspaceId: acme.id, role });

			await expect(
				browser.api.members.invite({
					workspaceId: acme.id,
					email: `by-${role}@acmeltd.example`,
					role: "author",
					sites: "all",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});

	test("an Owner who reaches some Sites offers only those Sites, never all of them", async () => {
		const owner = await install.createMember({ workspaceId: acme.id, role: "owner", sites: [bakery.id] });
		const invite = (sites: "all" | string[]) =>
			owner.browser.api.members.invite({
				workspaceId: acme.id,
				email: "limited@acmeltd.example",
				role: "owner",
				sites,
			});

		await expect(invite("all")).rejects.toMatchObject({ code: "ACCESS_NOT_HELD", status: 403 });
		// A Site they don't reach is one they can't see.
		await expect(invite([bakery.id, careers.id])).rejects.toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
		expect((await invite([bakery.id])).invite).toMatchObject({ role: "owner", sites: [{ id: bakery.id }] });
	});

	test("refuses Sites of another Workspace", async () => {
		const other = await install.createWorkspace("Elsewhere Ltd");
		const theirSite = await install.createSite(other.id);

		await expect(
			staff.browser.api.members.invite({
				workspaceId: acme.id,
				email: "x@acmeltd.example",
				role: "author",
				sites: [theirSite.id],
			}),
		).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
	});

	test("one Membership per Workspace: a Member of it can't be invited again", async () => {
		const { account } = await install.createMember({ workspaceId: acme.id, role: "author" });

		await expect(
			staff.browser.api.members.invite({ workspaceId: acme.id, email: account.email, role: "editor", sites: "all" }),
		).rejects.toMatchObject({ code: "ALREADY_MEMBER" });
	});

	test("Staff and the Superadmin can't be invited as Members", async () => {
		const other = await install.createStaff({ workspaces: "all" });
		const { person } = await admin.api.session.current();

		for (const address of [(await other.browser.api.session.current()).person?.email, person?.email]) {
			await expect(
				staff.browser.api.members.invite({ workspaceId: acme.id, email: address ?? "", role: "author", sites: "all" }),
			).rejects.toMatchObject({ code: "STAFF_MEMBERSHIP" });
		}
	});

	test("refuses a malformed email address", async () => {
		await expect(
			staff.browser.api.members.invite({ workspaceId: acme.id, email: "not an email", role: "author", sites: "all" }),
		).rejects.toMatchObject({ code: "EMAIL_INVALID" });
	});
});

describe("Member invite links", () => {
	test("work once", async () => {
		await staff.browser.api.members.invite({
			workspaceId: acme.id,
			email: "once@acmeltd.example",
			role: "author",
			sites: "all",
		});
		const token = await tokenFor("once@acmeltd.example");
		await install.browser().api.invites.accept({ token, name: "Once", password: TEST_PASSWORD, adminLanguage: "en" });

		await expect(install.browser().api.invites.get({ token })).rejects.toMatchObject({ code: "INVITE_INVALID" });
		await expect(
			install.browser().api.invites.accept({ token, name: "Twice", password: TEST_PASSWORD, adminLanguage: "en" }),
		).rejects.toMatchObject({ code: "INVITE_INVALID" });
	});

	test("stop working after 7 days, and leave the pending list", async () => {
		const later = await createTestInstall();
		try {
			const workspace = await later.createWorkspace("Acme Ltd");
			const superadmin = await later.superadmin();
			await superadmin.api.members.invite({
				workspaceId: workspace.id,
				email: "late@acmeltd.example",
				role: "author",
				sites: "all",
			});
			const token =
				new URL(inviteLinkIn(await later.lastEmailTo("late@acmeltd.example"))).searchParams.get("token") ?? "";

			await later.clock.advance(7 * DAY + 1000);

			await expect(later.browser().api.invites.get({ token })).rejects.toMatchObject({ code: "INVITE_INVALID" });
			await expect(
				later.browser().api.invites.accept({ token, name: "Late", password: TEST_PASSWORD, adminLanguage: "en" }),
			).rejects.toMatchObject({ code: "INVITE_INVALID" });
			expect((await (await later.superadmin()).api.members.list({ workspaceId: workspace.id })).invites).toEqual([]);
		} finally {
			await later.close();
		}
	});

	test("inviting the same address again replaces the invite, and the earlier link stops working", async () => {
		await staff.browser.api.members.invite({
			workspaceId: acme.id,
			email: "again@acmeltd.example",
			role: "editor",
			sites: "all",
		});
		const first = await tokenFor("again@acmeltd.example");
		await install.drainJobs();

		await staff.browser.api.members.invite({
			workspaceId: acme.id,
			email: "again@acmeltd.example",
			role: "author",
			sites: [bakery.id],
		});

		await expect(install.browser().api.invites.get({ token: first })).rejects.toMatchObject({ code: "INVITE_INVALID" });
		const { invites } = await staff.browser.api.members.list({ workspaceId: acme.id });
		expect(invites.filter((invite) => invite.email === "again@acmeltd.example")).toEqual([
			expect.objectContaining({ role: "author", sites: [{ id: bakery.id, name: "Acme Bakery" }] }),
		]);
	});

	test("resending sends a new link valid for 7 more days, and the earlier link stops working", async () => {
		const { invite } = await staff.browser.api.members.invite({
			workspaceId: acme.id,
			email: "resend@acmeltd.example",
			role: "author",
			sites: "all",
		});
		const first = await tokenFor("resend@acmeltd.example");
		await install.clock.advance(2 * DAY);

		const { invite: resent } = await staff.browser.api.members.resendInvite({
			workspaceId: acme.id,
			inviteId: invite.id,
		});
		const second = await tokenFor("resend@acmeltd.example");

		expect(resent).toMatchObject({ id: invite.id, expiresAt: new Date(install.clock.now().getTime() + 7 * DAY) });
		expect(second).not.toBe(first);
		await expect(install.browser().api.invites.get({ token: first })).rejects.toMatchObject({ code: "INVITE_INVALID" });
		expect((await install.browser().api.invites.get({ token: second })).email).toBe("resend@acmeltd.example");
	});

	test("a revoked invite's link stops working", async () => {
		const { invite } = await staff.browser.api.members.invite({
			workspaceId: acme.id,
			email: "revoked@acmeltd.example",
			role: "author",
			sites: "all",
		});
		const token = await tokenFor("revoked@acmeltd.example");

		await staff.browser.api.members.revokeInvite({ workspaceId: acme.id, inviteId: invite.id });

		await expect(install.browser().api.invites.get({ token })).rejects.toMatchObject({ code: "INVITE_INVALID" });
		const { invites } = await staff.browser.api.members.list({ workspaceId: acme.id });
		expect(invites.map((pending) => pending.email)).not.toContain("revoked@acmeltd.example");
	});

	test("an invite of another Workspace is not found under this Workspace", async () => {
		const other = await install.createWorkspace("Other Invites Ltd");
		const { invite } = await admin.api.members.invite({
			workspaceId: other.id,
			email: "theirs@other.example",
			role: "author",
			sites: "all",
		});

		await expect(
			staff.browser.api.members.revokeInvite({ workspaceId: acme.id, inviteId: invite.id }),
		).rejects.toMatchObject({ code: "INVITE_INVALID" });
		await expect(
			staff.browser.api.members.resendInvite({ workspaceId: acme.id, inviteId: invite.id }),
		).rejects.toMatchObject({ code: "INVITE_INVALID" });
	});

	test("an Owner can't resend or revoke an invite that grants more than they hold", async () => {
		const owner = await install.createMember({ workspaceId: acme.id, role: "owner", sites: [bakery.id] });
		const { invite } = await staff.browser.api.members.invite({
			workspaceId: acme.id,
			email: "wide@acmeltd.example",
			role: "editor",
			sites: "all",
		});

		for (const call of [owner.browser.api.members.resendInvite, owner.browser.api.members.revokeInvite]) {
			await expect(call({ workspaceId: acme.id, inviteId: invite.id })).rejects.toMatchObject({
				code: "ACCESS_NOT_HELD",
				data: { problem: "manage" },
			});
		}
		const { invites } = await owner.browser.api.members.list({ workspaceId: acme.id });
		expect(invites.find((pending) => pending.id === invite.id)).toMatchObject({ manageable: false });
	});
});
