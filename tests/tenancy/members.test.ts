// The Members of a Workspace: who they are, their role and the Sites they reach, changing that and
// removing them. Changes take effect on the Member's next request, even in a session already open.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let admin: TestBrowser;
let acme: { id: string; name: string };
let bakery: { id: string; slug: string };
let careers: { id: string; slug: string };

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	acme = await install.createWorkspace("Acme Ltd");
	bakery = await install.createSite(acme.id, { name: "Acme Bakery", slug: "bakery" });
	careers = await install.createSite(acme.id, { name: "Acme Careers", slug: "careers" });
});

afterAll(async () => {
	await install.close();
});

describe("the Members screen", () => {
	test("lists Members with their role and Sites, pending invites, and the Staff assigned to the Workspace", async () => {
		const workspace = await install.createWorkspace("Verde Travel");
		const site = await install.createSite(workspace.id, { name: "Verde Tours", slug: "tours" });
		await install.createStaff({ workspaces: [workspace.id], name: "Ciara Byrne" });
		await install.createStaff({ workspaces: [acme.id], name: "Not Assigned Here" });
		await install.createStaff({ workspaces: "all", name: "Alex Everywhere" });
		const owner = await install.createMember({
			workspaceId: workspace.id,
			role: "owner",
			name: "Sarah Murphy",
			email: "sarah@verde.example",
		});
		await install.createMember({
			workspaceId: workspace.id,
			role: "author",
			sites: [site.id],
			name: "Aoife Kelly",
			email: "aoife@verde.example",
		});
		await owner.browser.api.members.invite({
			workspaceId: workspace.id,
			email: "niamh@verde.example",
			role: "editor",
			sites: [site.id],
		});

		const list = await owner.browser.api.members.list({ workspaceId: workspace.id });

		expect(list.members).toEqual([
			{
				id: expect.any(String),
				name: "Aoife Kelly",
				email: "aoife@verde.example",
				role: "author",
				sites: [{ id: site.id, name: "Verde Tours" }],
				otherSites: 0,
				since: install.clock.now(),
				manageable: true,
			},
			{
				id: owner.personId,
				name: "Sarah Murphy",
				email: "sarah@verde.example",
				role: "owner",
				sites: "all",
				otherSites: 0,
				since: install.clock.now(),
				manageable: true,
			},
		]);
		expect(list.invites).toEqual([
			expect.objectContaining({
				email: "niamh@verde.example",
				role: "editor",
				sites: [{ id: site.id, name: "Verde Tours" }],
				invitedBy: { id: owner.personId, name: "Sarah Murphy" },
			}),
		]);
		expect(list.staff.map((person) => person.name)).toEqual(["Alex Everywhere", "Ciara Byrne"]);
		expect(list.offer).toEqual([
			{ role: "owner", allSites: true, sites: [site.id] },
			{ role: "editor", allSites: true, sites: [site.id] },
			{ role: "author", allSites: true, sites: [site.id] },
		]);
	});

	test("the agency Staff list is read-only: Owners can't invite, change or remove Staff from here", async () => {
		const staff = await install.createStaff({ workspaces: [acme.id], name: "Read Only" });
		const owner = await install.createMember({ workspaceId: acme.id, role: "owner" });

		expect((await owner.browser.api.members.list({ workspaceId: acme.id })).staff).toContainEqual({
			id: staff.personId,
			name: "Read Only",
		});
		await expect(
			owner.browser.api.members.remove({ workspaceId: acme.id, personId: staff.personId }),
		).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
		await expect(
			owner.browser.api.members.changeAccess({
				workspaceId: acme.id,
				personId: staff.personId,
				role: "author",
				sites: "all",
			}),
		).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
		await expect(owner.browser.api.staff.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("an Owner who reaches some Sites sees only those Sites by name, and offers only them", async () => {
		const owner = await install.createMember({ workspaceId: acme.id, role: "owner", sites: [bakery.id] });
		const editor = await install.createMember({ workspaceId: acme.id, role: "editor", sites: [bakery.id, careers.id] });

		const list = await owner.browser.api.members.list({ workspaceId: acme.id });

		expect(list.members.find((member) => member.id === editor.personId)).toMatchObject({
			sites: [{ id: bakery.id, name: "Acme Bakery" }],
			otherSites: 1,
			// They hold access the Owner doesn't.
			manageable: false,
		});
		expect(list.offer).toEqual([
			{ role: "owner", allSites: false, sites: [bakery.id] },
			{ role: "editor", allSites: false, sites: [bakery.id] },
			{ role: "author", allSites: false, sites: [bakery.id] },
		]);
	});

	test("Editors and Authors can't open it", async () => {
		for (const role of ["editor", "author"] as const) {
			const { browser } = await install.createMember({ workspaceId: acme.id, role });

			await expect(browser.api.members.list({ workspaceId: acme.id })).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
			});
		}
	});
});

describe("changing a Member's role and Sites", () => {
	test("takes effect on their next request, in the session they already have open", async () => {
		const member = await install.createMember({ workspaceId: acme.id, role: "editor" });
		expect((await member.browser.api.sites.get({ siteId: careers.id })).permissions).toContain("entry.publish");

		const { member: changed } = await admin.api.members.changeAccess({
			workspaceId: acme.id,
			personId: member.personId,
			role: "author",
			sites: [bakery.id],
		});

		expect(changed).toMatchObject({
			id: member.personId,
			role: "author",
			sites: [{ id: bakery.id, name: "Acme Bakery" }],
		});
		expect((await member.browser.api.sites.get({ siteId: bakery.id })).permissions).not.toContain("entry.publish");
		await expect(member.browser.api.sites.get({ siteId: careers.id })).rejects.toMatchObject({
			code: "SITE_NOT_FOUND",
		});
		expect((await member.browser.api.sites.list({ workspaceId: acme.id })).sites.map((site) => site.id)).toEqual([
			bakery.id,
		]);
	});

	test("an Owner can't give more than they hold, nor change someone who holds more", async () => {
		const owner = await install.createMember({ workspaceId: acme.id, role: "owner", sites: [bakery.id] });
		const author = await install.createMember({ workspaceId: acme.id, role: "author", sites: [bakery.id] });
		const wider = await install.createMember({ workspaceId: acme.id, role: "author", sites: "all" });
		const change = (personId: string, sites: "all" | string[]) =>
			owner.browser.api.members.changeAccess({ workspaceId: acme.id, personId, role: "editor", sites });

		await expect(change(author.personId, "all")).rejects.toMatchObject({
			code: "ACCESS_NOT_HELD",
			data: { problem: "grant" },
		});
		await expect(change(wider.personId, [bakery.id])).rejects.toMatchObject({
			code: "ACCESS_NOT_HELD",
			data: { problem: "manage" },
		});
		expect((await change(author.personId, [bakery.id])).member.role).toBe("editor");
	});

	test("Editors and Authors can't change anyone", async () => {
		const target = await install.createMember({ workspaceId: acme.id, role: "author" });
		const { browser } = await install.createMember({ workspaceId: acme.id, role: "editor" });

		await expect(
			browser.api.members.changeAccess({
				workspaceId: acme.id,
				personId: target.personId,
				role: "editor",
				sites: "all",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("refuses a person who isn't a Member of the Workspace", async () => {
		const elsewhere = await install.createWorkspace("Elsewhere Ltd");
		const stranger = await install.createMember({ workspaceId: elsewhere.id, role: "author" });

		await expect(
			admin.api.members.changeAccess({
				workspaceId: acme.id,
				personId: stranger.personId,
				role: "editor",
				sites: "all",
			}),
		).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
	});
});

describe("removing a Member", () => {
	test("takes effect on their next request; their account and other Memberships stay", async () => {
		const elsewhere = await install.createWorkspace("Second Ltd");
		const member = await install.createMember({ workspaceId: acme.id, role: "editor" });
		await install.addMembership({ personId: member.personId, workspaceId: elsewhere.id, role: "author" });
		const staff = await install.createStaff({ workspaces: [acme.id] });

		await staff.browser.api.members.remove({ workspaceId: acme.id, personId: member.personId });

		await expect(member.browser.api.workspaces.get({ workspaceId: acme.id })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
		await expect(member.browser.api.sites.get({ siteId: bakery.id })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
		expect((await member.browser.api.workspaces.list()).workspaces.map((workspace) => workspace.name)).toEqual([
			"Second Ltd",
		]);
		const { members } = await staff.browser.api.members.list({ workspaceId: acme.id });
		expect(members.map((listed) => listed.id)).not.toContain(member.personId);
	});

	test("a removed Member can be invited back", async () => {
		const member = await install.createMember({ workspaceId: acme.id, role: "author" });
		await admin.api.members.remove({ workspaceId: acme.id, personId: member.personId });

		const { invite } = await admin.api.members.invite({
			workspaceId: acme.id,
			email: member.account.email,
			role: "author",
			sites: "all",
		});

		expect(invite.email).toBe(member.account.email);
	});

	test("an Owner can't remove someone who holds more than they do", async () => {
		const owner = await install.createMember({ workspaceId: acme.id, role: "owner", sites: [bakery.id] });
		const wider = await install.createMember({ workspaceId: acme.id, role: "owner", sites: "all" });

		await expect(
			owner.browser.api.members.remove({ workspaceId: acme.id, personId: wider.personId }),
		).rejects.toMatchObject({ code: "ACCESS_NOT_HELD", data: { problem: "manage" } });
		await wider.browser.api.members.remove({ workspaceId: acme.id, personId: owner.personId });
		await expect(owner.browser.api.members.list({ workspaceId: acme.id })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
	});
});

describe("the Audit log", () => {
	test("records invites, joining, role and Site changes and removals, with who, when, how and the Workspace", async () => {
		const workspace = await install.createWorkspace("Audit Ltd");
		const site = await install.createSite(workspace.id, { name: "Audit Site", slug: "audit-site" });
		const { person: me } = await admin.api.session.current();
		const { invite } = await admin.api.members.invite({
			workspaceId: workspace.id,
			email: "audrey@audit.example",
			role: "editor",
			sites: "all",
		});
		await install.drainJobs();
		await admin.api.members.resendInvite({ workspaceId: workspace.id, inviteId: invite.id });
		await install.drainJobs();
		await admin.api.members.revokeInvite({ workspaceId: workspace.id, inviteId: invite.id });
		const member = await install.createMember({
			workspaceId: workspace.id,
			role: "editor",
			name: "Audrey Audit",
			email: "audrey@audit.example",
		});
		await admin.api.members.changeAccess({
			workspaceId: workspace.id,
			personId: member.personId,
			role: "author",
			sites: [site.id],
		});
		await admin.api.members.remove({ workspaceId: workspace.id, personId: member.personId });

		const { entries } = await admin.api.audit.list({ limit: 9 });

		const by = (personId: string | undefined) => ({
			id: expect.any(String),
			at: install.clock.now(),
			via: { kind: "admin" } as const,
			workspaceId: workspace.id,
			siteId: null,
			personId: personId ?? null,
		});
		const about = { memberId: member.personId, email: "audrey@audit.example" };
		expect(entries.reverse().filter((entry) => entry.action.startsWith("member."))).toEqual([
			{
				...by(me?.id),
				action: "member.invite",
				details: { email: "audrey@audit.example", role: "editor", sites: "all" },
			},
			{ ...by(me?.id), action: "member.resendInvite", details: { email: "audrey@audit.example" } },
			{ ...by(me?.id), action: "member.revokeInvite", details: { email: "audrey@audit.example" } },
			{
				...by(me?.id),
				action: "member.invite",
				details: { email: "audrey@audit.example", role: "editor", sites: "all" },
			},
			{
				...by(member.personId),
				action: "member.join",
				details: { email: "audrey@audit.example", role: "editor", sites: "all" },
			},
			{ ...by(me?.id), action: "member.changeRole", details: { ...about, from: "editor", to: "author" } },
			{ ...by(me?.id), action: "member.changeSites", details: { ...about, from: "all", to: [site.id] } },
			{
				...by(me?.id),
				action: "member.remove",
				details: { ...about, role: "author", sites: [site.id] },
			},
		]);
	});
});
