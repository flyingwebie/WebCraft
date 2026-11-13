// Who exports a Site and how its file is handed out: Staff and the Superadmin (`site.export`), never
// Members; a Sensitive action written to the Audit log; one export of a Site at a time, written by the
// worker as the person who asked, with their access checked again. The download link is signed, names
// one export of one Site, works only for people who may export it, and stops after 24 hours, when the
// file is deleted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { downloadExport, exportSite, manifestIn } from "../harness/site-transfer.ts";

let install: TestInstall;
let admin: TestBrowser;
let workspaceId: string;
let siteId: string;
let staff: { browser: TestBrowser; personId: string };
let colleague: TestBrowser;
let owner: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const made = await install.createStaff({ workspaces: [workspaceId] });
	staff = { browser: made.browser, personId: made.personId };
	colleague = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install?.close();
});

describe("who exports", () => {
	test("Staff and the Superadmin; never Owners or Editors", async () => {
		for (const member of [owner, editor]) {
			await expect(member.api.siteExports.start({ siteId, passphrase: null })).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
			});
			await expect(member.api.siteExports.list({ siteId })).rejects.toMatchObject({ status: 403 });
		}
		const done = await exportSite(install, admin, siteId);
		expect(done.status).toBe("done");
	});

	test("exporting and downloading are written to the Audit log", async () => {
		const view = await exportSite(install, staff.browser, siteId);
		expect((await downloadExport(install, staff.browser, view)).status).toBe(200);
		const { entries } = await admin.api.audit.list({ limit: 20, siteId });
		const actions = entries.filter((entry) => entry.personId === staff.personId).map((entry) => entry.action);
		expect(actions).toEqual(expect.arrayContaining(["site.export", "siteExport.download"]));
		const exported = entries.find((entry) => entry.action === "site.export" && entry.personId === staff.personId);
		expect(exported?.details).toMatchObject({ exportId: view.id, secrets: "dropped" });
	});

	test("one export of a Site at a time", async () => {
		await staff.browser.api.siteExports.start({ siteId, passphrase: null });
		await expect(colleague.api.siteExports.start({ siteId, passphrase: null })).rejects.toMatchObject({
			code: "SITE_EXPORT_RUNNING",
			status: 409,
		});
		await install.drainJobs();
	});

	test("the worker writes it as the person who asked, with their access as it is then", async () => {
		const outsider = await install.createStaff({ workspaces: [workspaceId] });
		const { export: started } = await outsider.browser.api.siteExports.start({ siteId, passphrase: null });
		await admin.api.staff.setWorkspaces({ personId: outsider.personId, workspaces: [] });
		await install.drainJobs();
		const { exports } = await admin.api.siteExports.list({ siteId });
		const written = exports.find((each) => each.id === started.id);
		expect(written).toMatchObject({ status: "failed", failure: { reason: "access" }, download: null });
	});
});

describe("the download link", () => {
	let view: Awaited<ReturnType<typeof exportSite>>;

	beforeAll(async () => {
		view = await exportSite(install, staff.browser, siteId);
	});

	test("hands out the archive, named, as a download nobody caches", async () => {
		const response = await downloadExport(install, staff.browser, view);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/x-tar");
		expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${view.fileName}"`);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(view.fileName).toMatch(/^webcraft-site-bakery-\d{8}-\d{6}\.tar$/);
		expect(manifestIn(new Uint8Array(await response.arrayBuffer())).site.slug).toBe("bakery");
	});

	test("works for anyone who may export the Site, and nobody else", async () => {
		expect((await downloadExport(install, colleague, view)).status).toBe(200);
		expect((await downloadExport(install, owner, view)).status).toBe(404);
		expect((await install.browser().request(install.adminUrl(view.download?.url ?? ""))).status).toBe(404);
	});

	test("holds only as signed: another export, Site or time is refused", async () => {
		const url = new URL(install.adminUrl(view.download?.url ?? ""));
		const tampered = new URL(url);
		tampered.searchParams.set("expires", String(Number(url.searchParams.get("expires")) + 3_600_000));
		expect((await staff.browser.request(tampered)).status).toBe(404);
		const otherSite = (await install.createSite(workspaceId, { name: "Other", slug: "other" })).id;
		const moved = new URL(url.toString().replace(siteId, otherSite));
		expect((await staff.browser.request(moved)).status).toBe(404);
		const signature = url.searchParams.get("signature") ?? "";
		const forged = new URL(url);
		forged.searchParams.set("signature", `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`);
		expect((await staff.browser.request(forged)).status).toBe(404);
	});

	test("stops after 24 hours, and the file is deleted", async () => {
		expect(view.download?.expiresAt).toEqual(new Date(install.clock.now().getTime() + 24 * 60 * 60 * 1000));
		const folder = join(install.storageDir, workspaceId, siteId, "exports", view.id);
		expect(readdirSync(folder)).toEqual(["part-000001"]);
		await install.clock.advance(24 * 60 * 60 * 1000 + 60_000);
		expect((await downloadExport(install, staff.browser, view)).status).toBe(404);
		await install.drainJobs();
		const { export: after } = await staff.browser.api.siteExports.get({ siteId, exportId: view.id });
		expect(after).toMatchObject({ status: "expired", download: null });
		// Its parts are gone from the Site's folder in storage.
		expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
	});
});
