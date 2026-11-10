// Who imports a Site export and what a start checks: Staff and the Superadmin (`site.import`), into a
// Workspace, as a new Site with a slug of its own, within the Workspace's Media quota; an upload is its
// uploader's alone; the worker reads it in as the person who started it, with their access then. Data
// of a Module this Install lacks is kept aside, and the Site import report says which Module it needs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type redirects from "@webcraft/module-redirects";

import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { exportedArchive, importArchive, rewritten, uploadArchive } from "../harness/site-transfer.ts";
import { approveModules } from "./support.ts";

let install: TestInstall;
let admin: TestBrowser;
let superadmin: TestAccount;
let staff: { browser: TestBrowser; personId: string };
let workspaceId: string;
let archive: Uint8Array;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
	await approveModules(install);
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await admin.api.modules.setOnSite({ siteId, moduleId: "redirects", on: true });
	await moduleApi<typeof redirects>(admin, "redirects").rules.add({ siteId, from: "/old", to: "/new", status: 301 });
	const made = await install.createStaff({ workspaces: [workspaceId] });
	staff = { browser: made.browser, personId: made.personId };
	archive = await exportedArchive(install, admin, siteId);
});

afterAll(async () => {
	await install?.close();
});

describe("who imports", () => {
	test("Staff and the Superadmin; never Owners or Editors", async () => {
		for (const role of ["owner", "editor"] as const) {
			const member = (await install.createMember({ workspaceId, role })).browser;
			await expect(
				member.api.siteImports.startUpload({ workspaceId, fileName: "site.tar", size: 100 }),
			).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
			await expect(member.api.siteImports.list({ workspaceId })).rejects.toMatchObject({ status: 403 });
		}
	});

	test("an upload is its uploader's alone: nobody else adds to it or starts it", async () => {
		const colleague = (await install.createStaff({ workspaces: [workspaceId] })).browser;
		const uploaded = await uploadArchive(staff.browser, workspaceId, archive);
		await expect(
			colleague.api.siteImports.start({
				workspaceId,
				importId: uploaded.id,
				name: "Mine",
				slug: "mine",
				passphrase: null,
			}),
		).rejects.toMatchObject({ code: "SITE_IMPORT_NOT_FOUND", status: 404 });
	});

	test("the worker reads it in as the person who started it, with their access as it is then", async () => {
		const leaving = await install.createStaff({ workspaces: [workspaceId] });
		const uploaded = await uploadArchive(leaving.browser, workspaceId, archive);
		await leaving.browser.api.siteImports.start({
			workspaceId,
			importId: uploaded.id,
			name: "Left",
			slug: "left",
			passphrase: null,
		});
		await admin.api.staff.setWorkspaces({ personId: leaving.personId, workspaces: [] });
		await install.drainJobs();
		const { import: after } = await admin.api.siteImports.get({ workspaceId, importId: uploaded.id });
		expect(after).toMatchObject({ status: "failed", failure: { reason: "access" }, site: null });
		expect((await admin.api.sites.list({ workspaceId })).sites.map((site) => site.slug)).not.toContain("left");
	});
});

describe("starting an import", () => {
	test("needs a slug of its own: never one another Site has, nor one the Install keeps", async () => {
		const uploaded = await uploadArchive(staff.browser, workspaceId, archive);
		const start = (slug: string) =>
			staff.browser.api.siteImports.start({ workspaceId, importId: uploaded.id, name: "Copy", slug, passphrase: null });
		await expect(start("bakery")).rejects.toMatchObject({ code: "SLUG_TAKEN", status: 409 });
		await expect(start("admin")).rejects.toMatchObject({ code: "SLUG_INVALID" });
		await expect(start("Not a slug!")).rejects.toMatchObject({ code: "SLUG_INVALID" });
	});

	test("keeps within the Workspace's Media storage quota", async () => {
		const quotaed = (await install.createWorkspace("Quota Ltd")).id;
		await admin.api.workspaces.setQuota({ workspaceId: quotaed, quotaBytes: 1024 * 1024 });
		const big = rewritten(archive, {
			manifest: (manifest) => {
				manifest.files.mediaBytes = 2 * 1024 * 1024;
			},
		});
		const uploaded = await uploadArchive(admin, quotaed, big);
		await expect(
			admin.api.siteImports.start({
				workspaceId: quotaed,
				importId: uploaded.id,
				name: "Big",
				slug: "big",
				passphrase: null,
			}),
		).rejects.toMatchObject({ code: "MEDIA_QUOTA_FULL", status: 413 });
	});

	test("can't start twice", async () => {
		const target = (await install.createWorkspace("Twice Ltd")).id;
		const done = await importArchive(install, admin, target, archive, { name: "Once", slug: "once" });
		expect(done.status).toBe("done");
		await expect(
			admin.api.siteImports.start({
				workspaceId: target,
				importId: done.id,
				name: "Again",
				slug: "again",
				passphrase: null,
			}),
		).rejects.toMatchObject({ code: "SITE_IMPORT_NOT_READY", status: 409 });
	});
});

describe("Modules", () => {
	test("data of a Module this Install lacks is kept aside, and the report says which Module it needs", async () => {
		const withUnavailable = rewritten(archive, {
			manifest: (manifest) => {
				manifest.modules.push({ id: "unavailable", version: "1.0.0", tables: ["records"] });
			},
			extraTables: [
				{
					name: "m_unavailable.records",
					module: "unavailable",
					rows: [{ id: crypto.randomUUID(), name: "Spring sale" }],
				},
			],
		});
		const target = (await install.createWorkspace("Missing Module Ltd")).id;
		const imported = await importArchive(install, admin, target, withUnavailable, {
			name: "Unavailable Module",
			slug: "unavailable",
		});
		expect(imported.status).toBe("done");
		expect(imported.report?.modules).toContainEqual({
			id: "unavailable",
			version: "1.0.0",
			status: "missing",
			keptAside: true,
		});
		expect(imported.archive?.modules).toContainEqual({ id: "unavailable", version: "1.0.0", status: "missing" });
		// Its rows wait in the new Site's private storage folder, for when this Install has the Module.
		const kept = join(
			install.storageDir,
			target,
			imported.site?.id ?? "",
			"kept-aside",
			"m_unavailable.records",
			"part-000001",
		);
		expect(gunzipSync(readFileSync(kept)).toString()).toContain('"name":"Spring sale"');
	});

	test("data of a Module waiting for approval here comes in, and works once it is approved", async () => {
		const fresh = await createTestInstall();
		try {
			const freshAdmin = await fresh.superadmin();
			const target = (await fresh.createWorkspace("Acme Ltd")).id;
			const imported = await importArchive(fresh, freshAdmin, target, archive, { name: "Acme", slug: "acme" });
			expect(imported.report?.modules).toContainEqual(
				expect.objectContaining({ id: "redirects", status: "waiting", keptAside: false }),
			);
			await approveModules(fresh);
			const { rules } = await moduleApi<typeof redirects>(freshAdmin, "redirects").rules.list({
				siteId: imported.site?.id ?? "",
			});
			expect(rules.map((rule) => [rule.from, rule.to])).toEqual([["/old", "/new"]]);
		} finally {
			await fresh.close();
		}
	});
});

describe("the Site import report", () => {
	test("is kept 90 days after the import ends", async () => {
		const target = (await install.createWorkspace("Kept Ltd")).id;
		const imported = await importArchive(install, admin, target, archive, { name: "Kept", slug: "kept" });
		expect(imported.expiresAt).toEqual(new Date(install.clock.now().getTime() + 90 * 24 * 60 * 60 * 1000));
		await install.clock.advance(91 * 24 * 60 * 60 * 1000);
		await install.drainJobs();
		const later = await install.signIn(superadmin);
		expect((await later.api.siteImports.list({ workspaceId: target })).imports).toEqual([]);
		// The Site it made stays.
		expect((await later.api.sites.list({ workspaceId: target })).sites.map((site) => site.slug)).toEqual(["kept"]);
	});
});
