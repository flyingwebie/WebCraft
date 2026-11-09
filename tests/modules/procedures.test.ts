// A Module's procedures and admin pages: namespaced by the Module's id in the Management API, run
// only where the Module runs, through can() with the Permissions it adds, refused anything it never
// declared; a procedure that fails goes to the Module log.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ModuleRefusal } from "@webcraft/module-sdk";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { sampleBoard } from "./sample/board.ts";
import { PROBES, sample } from "./sample/index.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample, sampleBoard] });
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	await admin.api.modules.approve({ moduleId: "sample-board", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId)).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const api = (browser: TestBrowser) => moduleApi<typeof sample>(browser, "sample");

describe("a Module's procedures", () => {
	test("work for people holding the Permission the Module gives their role, and are recorded under its id", async () => {
		const editor = await install.createMember({ workspaceId, role: "editor" });

		const { note } = await api(editor.browser).notes.add({ siteId, body: "Call the printer" });

		expect(note).toMatchObject({ body: "Call the printer", source: "person" });
		expect((await api(staff).notes.list({ siteId })).notes.map((listed) => listed.id)).toContain(note.id);
		const { entries } = await (await install.superadmin()).api.audit.list();
		expect(entries[0]).toMatchObject({
			action: "sample.note.add",
			personId: editor.personId,
			via: { kind: "admin" },
			workspaceId,
			siteId,
			details: { noteId: note.id },
		});
	});

	test("refuse people whose role the Module doesn't give its Permission", async () => {
		const author = await install.createMember({ workspaceId, role: "author" });

		await expect(api(author.browser).notes.list({ siteId })).resolves.toBeDefined();
		await expect(api(author.browser).notes.add({ siteId, body: "Not mine to add" })).rejects.toMatchObject({
			code: "FORBIDDEN",
			status: 403,
			data: { permission: "sample.notes.edit" },
		});
	});

	test("check their input", async () => {
		await expect(api(staff).notes.add({ siteId, body: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("answer a Module's own refusals with MODULE_ERROR", async () => {
		await expect(
			api(staff).notes.share({ siteId, noteId: crypto.randomUUID(), email: "someone@client.example" }),
		).rejects.toMatchObject({ code: "MODULE_ERROR", status: 404, data: { code: "note-not-found" } });
	});

	test("that fail answer MODULE_FAILED and leave the reason in the Module log", async () => {
		await expect(api(staff).broken({ siteId })).rejects.toMatchObject({ code: "MODULE_FAILED", status: 500 });

		const { lines } = await (await install.superadmin()).api.modules.log({ moduleId: "sample" });
		expect(lines[0]).toMatchObject({
			level: "error",
			message: "The procedure broken failed.",
			workspaceId,
			siteId,
			details: { procedure: "broken", error: { message: "The sample's broken procedure broke, as it should." } },
		});
	});

	test("refuse a Site of another Workspace, as if it didn't exist", async () => {
		const theirs = await install.createSite((await install.createWorkspace()).id);

		await expect(api(staff).notes.list({ siteId: theirs.id })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
	});

	test("of a Workspace-level Module take the Workspace, and the Permission its roles hold there", async () => {
		const admin = await install.superadmin();
		await admin.api.modules.setOnWorkspace({ workspaceId, moduleId: "sample-board", on: true });
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const editor = await install.createMember({ workspaceId, role: "editor" });
		const board = (browser: TestBrowser) => moduleApi<typeof sampleBoard>(browser, "sample-board");

		await board(owner.browser).pins.add({ workspaceId, text: "Owners pin" });

		await expect(board(editor.browser).pins.add({ workspaceId, text: "Editors don't" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect((await board(editor.browser).pins.list({ workspaceId })).pins.map((pin) => pin.text)).toEqual([
			"Owners pin",
		]);
	});
});

describe("what a Module never declared", () => {
	for (const attempt of PROBES) {
		test(`is refused: ${attempt}`, async () => {
			const expected: Record<(typeof PROBES)[number], ModuleRefusal> = {
				"stray-table": "table",
				"other-module-table": "table",
				"undeclared-host": "host",
				"undeclared-job": "job",
				"undeclared-permission": "permission",
				"bad-secret-name": "secret",
				"unset-secret": "secret",
				email: "email",
			};

			expect(await api(staff).probe({ siteId, attempt })).toEqual({ refused: expected[attempt] });
		});
	}

	test("nothing reaches an outside host it didn't declare", async () => {
		expect(install.http.requests.filter((request) => request.url.startsWith("https://elsewhere.example"))).toEqual([]);
	});
});

describe("a Module's admin pages", () => {
	test("are in the navigation of the Sites where it runs, for people holding their Permission", async () => {
		const site = await install.createSite(workspaceId);

		expect((await staff.api.sites.get({ siteId: site.id })).modulePages).toEqual([
			{ moduleId: "sample", path: "notes", label: "Notes" },
		]);

		await staff.api.modules.setOnSite({ siteId: site.id, moduleId: "sample", on: false });
		expect((await staff.api.sites.get({ siteId: site.id })).modulePages).toEqual([]);
	});

	test("aren't shown while the Module waits for approval", async () => {
		const waiting = await createTestInstall({ modules: [sample] });
		try {
			const admin = await waiting.superadmin();
			const site = await waiting.createSite((await waiting.createWorkspace()).id);

			expect((await admin.api.sites.get({ siteId: site.id })).modulePages).toEqual([]);
		} finally {
			await waiting.close();
		}
	});

	test("of Workspace-level Modules are in the Workspace's navigation", async () => {
		const workspace = await install.createWorkspace();
		const admin = await install.superadmin();
		expect((await admin.api.workspaces.get({ workspaceId: workspace.id })).modulePages).toEqual([]);

		await admin.api.modules.setOnWorkspace({ workspaceId: workspace.id, moduleId: "sample-board", on: true });

		expect((await admin.api.workspaces.get({ workspaceId: workspace.id })).modulePages).toEqual([
			{ moduleId: "sample-board", path: "board", label: "Board" },
		]);
	});
});

describe("the Module log", () => {
	test("keeps a line for 90 days", async () => {
		const kept = await createTestInstall({ modules: [sample] });
		try {
			await (await kept.superadmin()).api.modules.approve({ moduleId: "sample", version: "1.0.0" });
			const site = await kept.createSite((await kept.createWorkspace()).id);
			await expect(api(await kept.superadmin()).broken({ siteId: site.id })).rejects.toMatchObject({
				code: "MODULE_FAILED",
			});
			const lines = async () => (await (await kept.superadmin()).api.modules.log({ moduleId: "sample" })).lines;
			const DAY = 24 * 60 * 60 * 1000;

			await kept.clock.advance(89 * DAY);
			await kept.drainJobs();
			expect(await lines()).toHaveLength(1);

			await kept.clock.advance(2 * DAY);
			await kept.drainJobs();
			expect(await lines()).toEqual([]);
		} finally {
			await kept.close();
		}
	});
});
