// Switching Modules (story 149): Staff switch Site-level Modules per Site and Workspace-level ones
// per Workspace. Off keeps the Module's data; removing it deletes the data after a confirmation.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { sampleBoard } from "./sample/board.ts";
import { sample } from "./sample/index.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let otherSiteId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample, sampleBoard] });
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	await admin.api.modules.approve({ moduleId: "sample-board", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId)).id;
	otherSiteId = (await install.createSite(workspaceId)).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const notes = (browser: TestBrowser) => moduleApi<typeof sample>(browser, "sample").notes;
const pins = (browser: TestBrowser) => moduleApi<typeof sampleBoard>(browser, "sample-board").pins;

describe("Site-level Modules", () => {
	test("are listed on each Site, on by default once approved", async () => {
		const { modules } = await staff.api.modules.siteList({ siteId });

		expect(modules).toEqual([
			{
				id: "sample",
				name: "Sample notes",
				description: "Keeps notes on each Site: the Module SDK's working example.",
				version: "1.0.0",
				status: "approved",
				on: true,
				onByDefault: true,
			},
		]);
	});

	test("switched off on one Site, stop there only, and keep their data", async () => {
		const site = await install.createSite(workspaceId);
		await notes(staff).add({ siteId: site.id, body: "Kept while off" });

		const { module } = await staff.api.modules.setOnSite({ siteId: site.id, moduleId: "sample", on: false });

		expect(module.on).toBe(false);
		await expect(notes(staff).list({ siteId: site.id })).rejects.toMatchObject({
			code: "MODULE_NOT_FOUND",
			status: 404,
		});
		await expect(notes(staff).list({ siteId: otherSiteId })).resolves.toBeDefined();

		await staff.api.modules.setOnSite({ siteId: site.id, moduleId: "sample", on: true });
		const { notes: kept } = await notes(staff).list({ siteId: site.id });
		expect(kept.map((note) => note.body)).toEqual(["Kept while off"]);
		const { entries } = await (await install.superadmin()).api.audit.list();
		expect(entries.slice(0, 2).map((entry) => [entry.action, entry.siteId, entry.details])).toEqual([
			["module.switchOn", site.id, { moduleId: "sample" }],
			["module.switchOff", site.id, { moduleId: "sample" }],
		]);
	});

	test("are switched by Staff, not by Members", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });

		await expect(owner.browser.api.modules.siteList({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.browser.api.modules.setOnSite({ siteId, moduleId: "sample", on: false })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("waiting for approval can only be switched off", async () => {
		const waiting = await createTestInstall({ modules: [sample] });
		try {
			const admin = await waiting.superadmin();
			const workspace = await waiting.createWorkspace();
			const site = await waiting.createSite(workspace.id);

			expect((await admin.api.modules.siteList({ siteId: site.id })).modules[0]).toMatchObject({
				status: "waiting",
				on: true,
			});
			await expect(notes(admin).list({ siteId: site.id })).rejects.toMatchObject({ code: "MODULE_NOT_FOUND" });
			await expect(
				admin.api.modules.setOnSite({ siteId: site.id, moduleId: "sample", on: true }),
			).rejects.toMatchObject({ code: "MODULE_NOT_APPROVED", status: 409 });
			await admin.api.modules.setOnSite({ siteId: site.id, moduleId: "sample", on: false });
		} finally {
			await waiting.close();
		}
	});

	test("aren't switched on Workspaces, nor Workspace-level ones on Sites", async () => {
		await expect(staff.api.modules.setOnWorkspace({ workspaceId, moduleId: "sample", on: true })).rejects.toMatchObject(
			{ code: "MODULE_NOT_FOUND" },
		);
		await expect(staff.api.modules.setOnSite({ siteId, moduleId: "sample-board", on: true })).rejects.toMatchObject({
			code: "MODULE_NOT_FOUND",
		});
	});
});

describe("Workspace-level Modules", () => {
	test("are listed on each Workspace, off until Staff switch them on there", async () => {
		const workspace = await install.createWorkspace();
		const admin = await install.superadmin();

		expect((await admin.api.modules.workspaceList({ workspaceId: workspace.id })).modules).toEqual([
			expect.objectContaining({ id: "sample-board", status: "approved", on: false, onByDefault: false }),
		]);
		await expect(pins(admin).list({ workspaceId: workspace.id })).rejects.toMatchObject({ code: "MODULE_NOT_FOUND" });

		await admin.api.modules.setOnWorkspace({ workspaceId: workspace.id, moduleId: "sample-board", on: true });
		await pins(admin).add({ workspaceId: workspace.id, text: "Launch on Monday" });

		expect((await pins(admin).list({ workspaceId: workspace.id })).pins.map((pin) => pin.text)).toEqual([
			"Launch on Monday",
		]);
		await expect(pins(admin).list({ workspaceId })).rejects.toMatchObject({ code: "MODULE_NOT_FOUND" });
	});
});

describe("removing a Module's data", () => {
	test("first answers what would be deleted, then deletes it with the confirmation and switches the Module off", async () => {
		const site = await install.createSite(workspaceId);
		await notes(staff).add({ siteId: site.id, body: "One" });
		await notes(staff).add({ siteId: site.id, body: "Two" });
		await notes(staff).add({ siteId: otherSiteId, body: "Another Site's" });

		const asked = await staff.api.modules.removeSiteData({ siteId: site.id, moduleId: "sample" });

		expect(asked).toEqual({
			removed: false,
			tables: [{ table: "notes", rows: 2 }],
			secrets: 0,
			confirmation: { id: expect.any(String), expiresAt: expect.any(Date) },
		});
		expect((await notes(staff).list({ siteId: site.id })).notes).toHaveLength(2);
		if (asked.removed) throw new Error("Nothing should be removed before the confirmation.");

		const done = await staff.api.modules.removeSiteData({
			siteId: site.id,
			moduleId: "sample",
			confirmation: asked.confirmation.id,
		});

		expect(done).toEqual({ removed: true, tables: [{ table: "notes", rows: 2 }], secrets: 0 });
		expect((await staff.api.modules.siteList({ siteId: site.id })).modules[0]?.on).toBe(false);
		await staff.api.modules.setOnSite({ siteId: site.id, moduleId: "sample", on: true });
		expect((await notes(staff).list({ siteId: site.id })).notes).toEqual([]);
		expect((await notes(staff).list({ siteId: otherSiteId })).notes.map((note) => note.body)).toContain(
			"Another Site's",
		);
		const { entries } = await (await install.superadmin()).api.audit.list();
		expect(entries.find((entry) => entry.action === "module.removeData")).toMatchObject({
			siteId: site.id,
			details: { moduleId: "sample", tables: [{ table: "notes", rows: 2 }], secrets: 0 },
		});
	});

	test("removes the Module's secrets there too, and only there", async () => {
		const site = await install.createSite(workspaceId);
		const settings = moduleApi<typeof sample>(staff, "sample").settings;
		await settings.setHookToken({ siteId: site.id, token: "removed-with-the-data-0123" });
		await settings.setHookToken({ siteId: otherSiteId, token: "kept-on-the-other-site-0123" });

		const asked = await staff.api.modules.removeSiteData({ siteId: site.id, moduleId: "sample" });
		if (asked.removed) throw new Error("Nothing should be removed before the confirmation.");
		expect(asked.secrets).toBe(1);
		await staff.api.modules.removeSiteData({
			siteId: site.id,
			moduleId: "sample",
			confirmation: asked.confirmation.id,
		});

		await staff.api.modules.setOnSite({ siteId: site.id, moduleId: "sample", on: true });
		const removed = await settings.checkHook({ siteId: site.id });
		expect(removed.seen?.join("\n")).toContain("isn't set");
		install.http.respond("GET", /^https:\/\/hooks\.sample\.example\/check\//, { status: 204 });
		install.dns.answer("hooks.sample.example", ["93.184.216.34"]);
		expect(await settings.checkHook({ siteId: otherSiteId })).toEqual({ status: 204, seen: null });
	});

	test("refuses a confirmation once what it would delete has changed", async () => {
		const site = await install.createSite(workspaceId);
		await notes(staff).add({ siteId: site.id, body: "Before" });
		const asked = await staff.api.modules.removeSiteData({ siteId: site.id, moduleId: "sample" });
		if (asked.removed) throw new Error("Nothing should be removed before the confirmation.");
		await notes(staff).add({ siteId: site.id, body: "After" });

		await expect(
			staff.api.modules.removeSiteData({ siteId: site.id, moduleId: "sample", confirmation: asked.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "changed" } });
	});

	test("of a Workspace-level Module removes it from that Workspace only", async () => {
		const admin = await install.superadmin();
		const ours = await install.createWorkspace();
		const theirs = await install.createWorkspace();
		for (const workspace of [ours, theirs]) {
			await admin.api.modules.setOnWorkspace({ workspaceId: workspace.id, moduleId: "sample-board", on: true });
			await pins(admin).add({ workspaceId: workspace.id, text: "A pin" });
		}

		const asked = await admin.api.modules.removeWorkspaceData({ workspaceId: ours.id, moduleId: "sample-board" });
		if (asked.removed) throw new Error("Nothing should be removed before the confirmation.");
		expect(asked.tables).toEqual([{ table: "pins", rows: 1 }]);
		await admin.api.modules.removeWorkspaceData({
			workspaceId: ours.id,
			moduleId: "sample-board",
			confirmation: asked.confirmation.id,
		});

		expect((await pins(admin).list({ workspaceId: theirs.id })).pins).toHaveLength(1);
		await admin.api.modules.setOnWorkspace({ workspaceId: ours.id, moduleId: "sample-board", on: true });
		expect((await pins(admin).list({ workspaceId: ours.id })).pins).toEqual([]);
	});
});
