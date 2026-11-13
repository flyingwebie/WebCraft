// The role table: every built-in role is a fixed set of Permissions (ADR 0028). One test per row:
// a person holding the role sees exactly its Permissions on the Install, in a Workspace and on a
// Site they reach. The admin asks for these lists to decide what to offer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
});

afterAll(async () => {
	await install.close();
});

/** The Permissions `browser`'s person holds on the Install, in the Workspace and on the Site. */
async function permissionsOf(browser: TestBrowser) {
	return {
		install: (await browser.api.shell.context()).permissions,
		workspace: (await browser.api.workspaces.get({ workspaceId })).permissions,
		site: (await browser.api.sites.get({ siteId })).permissions,
	};
}

describe("the role table", () => {
	test("superadmin: every Permission, everywhere", async () => {
		expect(await permissionsOf(await install.superadmin())).toEqual({
			install: [
				"install.manage",
				"workspace.create",
				"staff.manage",
				"account.deactivate",
				"audit.view",
				"module.approve",
				"installHealth.manage",
				"impersonation.start",
				"servicesList.edit",
			],
			workspace: [
				"audit.view",
				"workspace.view",
				"site.create",
				"site.import",
				"member.invite",
				"member.manage",
				"twoFactor.require",
				"twoFactor.reset",
				"impersonation.start",
				"module.manage",
				"quota.manage",
				"aiKey.manage",
				"aiUsage.view",
				"protectedTerms.edit",
				"dashboard.manage",
				"dashboard.view",
				"report.manage",
				"report.view",
				"reportRecipients.edit",
				"shareLink.manage",
				"shareLink.view",
				"reportBranding.manage",
			],
			site: [
				"module.manage",
				"aiUsage.view",
				"protectedTerms.edit",
				"site.view",
				"site.export",
				"staging.manage",
				"structure.edit",
				"aiCrawlers.manage",
				"entry.edit",
				"entry.publish",
				"formEmails.edit",
				"entry.delete",
				"media.upload",
				"media.manage",
				"import.run",
				"translation.manage",
				"dashboard.manage",
				"dashboard.view",
				"report.manage",
				"report.view",
				"reportRecipients.edit",
				"shareLink.manage",
				"shareLink.view",
				"reportBranding.manage",
			],
		});
	});

	test("staff: everything in their Workspaces, including Structure, new Sites, Site exports and imports, Modules, storage quotas, Reports, Share links and Members' two-factor resets; on the Install, only the Services list", async () => {
		const { browser } = await install.createStaff({ workspaces: [workspaceId] });

		expect(await permissionsOf(browser)).toEqual({
			install: ["servicesList.edit"],
			workspace: [
				"audit.view",
				"workspace.view",
				"site.create",
				"site.import",
				"member.invite",
				"member.manage",
				"twoFactor.require",
				"twoFactor.reset",
				"impersonation.start",
				"module.manage",
				"quota.manage",
				"aiKey.manage",
				"aiUsage.view",
				"protectedTerms.edit",
				"dashboard.manage",
				"dashboard.view",
				"report.manage",
				"report.view",
				"reportRecipients.edit",
				"shareLink.manage",
				"shareLink.view",
				"reportBranding.manage",
			],
			site: [
				"module.manage",
				"aiUsage.view",
				"protectedTerms.edit",
				"site.view",
				"site.export",
				"staging.manage",
				"structure.edit",
				"aiCrawlers.manage",
				"entry.edit",
				"entry.publish",
				"formEmails.edit",
				"entry.delete",
				"media.upload",
				"media.manage",
				"import.run",
				"translation.manage",
				"dashboard.manage",
				"dashboard.view",
				"report.manage",
				"report.view",
				"reportRecipients.edit",
				"shareLink.manage",
				"shareLink.view",
				"reportBranding.manage",
			],
		});
	});

	test("owner: manages Members (and requires two-factor authentication of them), the AI key, the staging password and the AI crawler setting, publishes and deletes Entries, changes Form emails, Translation modes and Report recipients, imports CSV files, sees Dashboards, Reports and Share links, but never changes Structure, builds Dashboards or creates Sites", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "owner" });

		expect(await permissionsOf(browser)).toEqual({
			install: [],
			workspace: [
				"audit.view",
				"workspace.view",
				"member.invite",
				"member.manage",
				"twoFactor.require",
				"aiKey.manage",
				"aiUsage.view",
				"protectedTerms.edit",
				"dashboard.view",
				"report.view",
				"reportRecipients.edit",
				"shareLink.view",
			],
			site: [
				"aiUsage.view",
				"protectedTerms.edit",
				"site.view",
				"staging.manage",
				"aiCrawlers.manage",
				"entry.edit",
				"entry.publish",
				"formEmails.edit",
				"entry.delete",
				"media.upload",
				"media.manage",
				"import.run",
				"translation.manage",
				"dashboard.view",
				"report.view",
				"reportRecipients.edit",
				"shareLink.view",
			],
		});
	});

	test("editor: edits, publishes and deletes Content, changes Form emails and Protected terms, imports CSV files, and manages every Media file", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "editor" });

		expect(await permissionsOf(browser)).toEqual({
			install: [],
			workspace: ["workspace.view", "protectedTerms.edit"],
			site: [
				"protectedTerms.edit",
				"site.view",
				"entry.edit",
				"entry.publish",
				"formEmails.edit",
				"entry.delete",
				"media.upload",
				"media.manage",
				"import.run",
			],
		});
	});

	test("author: edits Content and uploads Media (changing only their own), but can't publish or delete Entries, change Form emails, nor import", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "author" });

		expect(await permissionsOf(browser)).toEqual({
			install: [],
			workspace: ["workspace.view"],
			site: ["site.view", "entry.edit", "media.upload"],
		});
	});
});

describe("what a role reaches", () => {
	test("Staff reach only the Workspaces they are assigned to, and every Site in them", async () => {
		const other = await install.createWorkspace("Other Ltd");
		const otherSite = await install.createSite(other.id);
		const { browser } = await install.createStaff({ workspaces: [workspaceId] });

		await expect(browser.api.workspaces.get({ workspaceId: other.id })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
		await expect(browser.api.sites.get({ siteId: otherSite.id })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
		const later = await install.createSite(workspaceId);
		expect((await browser.api.sites.get({ siteId: later.id })).site.id).toBe(later.id);
	});

	test("a Member reaches only their own Workspace, and only the Sites their Membership names", async () => {
		const chosen = await install.createSite(workspaceId);
		const { browser } = await install.createMember({ workspaceId, role: "editor", sites: [chosen.id] });

		expect((await browser.api.sites.get({ siteId: chosen.id })).permissions).toContain("entry.publish");
		await expect(browser.api.sites.get({ siteId })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
		expect((await browser.api.sites.list({ workspaceId })).sites.map((site) => site.id)).toEqual([chosen.id]);
		expect((await browser.api.workspaces.list()).workspaces).toEqual([
			expect.objectContaining({ id: workspaceId, siteCount: 1 }),
		]);
	});

	test("Members can't create Sites, even Owners", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "owner" });

		await expect(
			browser.api.sites.create({ workspaceId, name: "Owner's Site", slug: "owners-site" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("people with no role reach nothing", async () => {
		const { browser } = await install.createMember({ workspaceId, role: "author" });
		const other = await install.createWorkspace("Elsewhere Ltd");

		await expect(browser.api.workspaces.get({ workspaceId: other.id })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
		await expect(browser.api.workspaces.create({ name: "Mine Now" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(browser.api.install.settings.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("each role against Workspace and Site scope", () => {
	/** The Site-level Permissions each Workspace role holds, from the role table above. */
	const onSite = {
		owner: [
			"aiUsage.view",
			"protectedTerms.edit",
			"site.view",
			"staging.manage",
			"aiCrawlers.manage",
			"entry.edit",
			"entry.publish",
			"formEmails.edit",
			"entry.delete",
			"media.upload",
			"media.manage",
			"import.run",
			"translation.manage",
			"dashboard.view",
			"report.view",
			"reportRecipients.edit",
			"shareLink.view",
		],
		editor: [
			"protectedTerms.edit",
			"site.view",
			"entry.edit",
			"entry.publish",
			"formEmails.edit",
			"entry.delete",
			"media.upload",
			"media.manage",
			"import.run",
		],
		author: ["site.view", "entry.edit", "media.upload"],
	} as const;

	for (const role of ["owner", "editor", "author"] as const) {
		test(`${role} reaching chosen Sites: their Workspace and those Sites, no other Site, no other Workspace`, async () => {
			const ours = await install.createWorkspace();
			const chosen = await install.createSite(ours.id);
			const notChosen = await install.createSite(ours.id);
			const theirs = await install.createWorkspace();
			const theirSite = await install.createSite(theirs.id);
			const { browser } = await install.createMember({ workspaceId: ours.id, role, sites: [chosen.id] });

			expect((await browser.api.workspaces.get({ workspaceId: ours.id })).permissions).toContain("workspace.view");
			expect((await browser.api.sites.get({ siteId: chosen.id })).permissions).toEqual([...onSite[role]]);
			await expect(browser.api.sites.get({ siteId: notChosen.id })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
			// Sites created later stay out of reach too.
			const later = await install.createSite(ours.id);
			await expect(browser.api.sites.get({ siteId: later.id })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
			await expect(browser.api.workspaces.get({ workspaceId: theirs.id })).rejects.toMatchObject({
				code: "WORKSPACE_NOT_FOUND",
			});
			await expect(browser.api.sites.get({ siteId: theirSite.id })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
		});

		test(`${role} reaching all Sites: every Site of their Workspace, including later ones, and nothing elsewhere`, async () => {
			const ours = await install.createWorkspace();
			const first = await install.createSite(ours.id);
			const theirs = await install.createWorkspace();
			const theirSite = await install.createSite(theirs.id);
			const { browser } = await install.createMember({ workspaceId: ours.id, role, sites: "all" });
			const later = await install.createSite(ours.id);

			for (const site of [first, later]) {
				expect((await browser.api.sites.get({ siteId: site.id })).permissions).toEqual([...onSite[role]]);
			}
			await expect(browser.api.sites.get({ siteId: theirSite.id })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
		});
	}
});

describe("Staff never hold a Membership", () => {
	test("Staff can't be given a Membership", async () => {
		const { personId } = await install.createStaff({ workspaces: "all" });

		await expect(install.addMembership({ personId, workspaceId, role: "owner" })).rejects.toThrow(
			"Staff never hold a Membership",
		);
	});

	test("the Superadmin can't be given a Membership either", async () => {
		const { person } = await (await install.superadmin()).api.session.current();

		await expect(install.addMembership({ personId: person?.id ?? "", workspaceId, role: "owner" })).rejects.toThrow(
			"Staff never hold a Membership",
		);
	});

	test("a Member can't be invited as Staff", async () => {
		const { account } = await install.createMember({ workspaceId, role: "editor" });

		await expect(
			(await install.superadmin()).api.staff.invite({ email: account.email, workspaces: "all" }),
		).rejects.toMatchObject({ code: "EMAIL_IN_USE" });
	});
});
