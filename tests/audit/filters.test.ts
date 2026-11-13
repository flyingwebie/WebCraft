// The Audit log's filters (who, action, how, Site, dates), its pages, its CSV export, and that no
// procedure changes or deletes an entry.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestBrowser;
let acme: string;
let bakery: string;
let catering: string;
let staff: { personId: string; browser: TestBrowser };

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.superadmin();
	acme = (await install.createWorkspace("Acme Ltd")).id;
	staff = await install.createStaff({ workspaces: [acme], name: "Agency Anna" });
	await install.clock.advance(60_000);
	bakery = (await staff.browser.api.sites.create({ workspaceId: acme, name: "Acme Bakery", slug: "bakery" })).site.id;
	await install.clock.advance(60_000);
	catering = (await superadmin.api.sites.create({ workspaceId: acme, name: "Acme Catering", slug: "catering" })).site
		.id;
});

afterAll(async () => {
	await install.close();
});

describe("filters", () => {
	test("by who: what one person did", async () => {
		const { entries } = await staff.browser.api.audit.list({ workspaceId: acme, personId: staff.personId });

		expect(entries.map((entry) => [entry.action, entry.siteId])).toEqual([["site.create", bakery]]);
	});

	test("by action", async () => {
		const { entries } = await staff.browser.api.audit.list({ workspaceId: acme, action: "site.create" });

		expect(entries.map((entry) => entry.siteId)).toEqual([catering, bakery]);
	});

	test("by how it came in", async () => {
		const token = await createApiToken(staff.browser, { name: "Deploy script", workspaceId: acme });
		await tokenClient(install, token.secret).api.sites.list({ workspaceId: acme });
		await install.clock.advance(60_000);
		const script = tokenClient(install, token.secret);
		await script.api.languages.add({ siteId: bakery, code: "fr" });

		const { entries } = await staff.browser.api.audit.list({ workspaceId: acme, via: "token" });
		expect(entries.map((entry) => [entry.action, entry.via])).toEqual([
			["language.add", { kind: "token", name: "Deploy script" }],
		]);
		const fromAdmin = await staff.browser.api.audit.list({ workspaceId: acme, via: "admin" });
		expect(fromAdmin.entries.map((entry) => entry.action)).not.toContain("language.add");
	});

	test("by Site", async () => {
		const { entries } = await superadmin.api.audit.list({ siteId: catering });

		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.siteId === catering)).toBe(true);
	});

	test("by dates: from the first, up to the second (not included)", async () => {
		const start = new Date("2026-03-02T09:00:00Z");
		const { entries } = await superadmin.api.audit.list({
			workspaceId: acme,
			action: "site.create",
			from: new Date(start.getTime() + 60_000),
			to: new Date(start.getTime() + 120_000),
		});

		expect(entries.map((entry) => entry.siteId)).toEqual([bakery]);
	});
});

describe("pages", () => {
	test("go newest first, and a later entry never moves an older page", async () => {
		const workspace = (await install.createWorkspace("Paged Ltd")).id;
		for (const name of ["One", "Two", "Three", "Four", "Five"]) {
			await superadmin.api.sites.create({ workspaceId: workspace, name, slug: `paged-${name.toLowerCase()}` });
		}
		const read = (after?: string) =>
			superadmin.api.audit.list({
				workspaceId: workspace,
				action: "site.create",
				limit: 2,
				...(after ? { after } : {}),
			});
		const named = (page: Awaited<ReturnType<typeof read>>) => page.entries.map((entry) => entry.details.name);

		const first = await read();
		expect(named(first)).toEqual(["Five", "Four"]);
		await superadmin.api.sites.create({ workspaceId: workspace, name: "Six", slug: "paged-six" });
		const second = await read(first.next ?? "");
		const third = await read(second.next ?? "");

		expect(named(second)).toEqual(["Three", "Two"]);
		expect(named(third)).toEqual(["One"]);
		expect(third.next).toBeNull();
		expect(named(await read())).toEqual(["Six", "Five"]);
	});
});

describe("the CSV export", () => {
	test("holds what the filters read, and a value can never become a formula", async () => {
		const workspace = (await install.createWorkspace('=HYPERLINK("https://evil.example")')).id;
		await superadmin.api.sites.create({ workspaceId: workspace, name: "+Plus site", slug: "plus-site" });
		// The full-width signs start a formula too, where spreadsheets read East Asian text.
		await superadmin.api.sites.create({ workspaceId: workspace, name: "＋Full-width site", slug: "full-width-site" });

		const file = await superadmin.api.audit.export({ workspaceId: workspace });

		expect(file.filename).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
		expect(file.truncated).toBe(false);
		const lines = file.csv.replace(/^﻿/, "").trim().split("\r\n");
		expect(lines[0]).toBe('"time_utc","action","person","email","via","via_name","workspace","site","details"');
		// Newest first: the Site, then the Workspace that holds it.
		expect(lines.slice(1).map((line) => line.split(",")[1])).toEqual([
			'"site.create"',
			'"site.create"',
			'"workspace.create"',
		]);
		expect(lines[1]).toContain(`"'＋Full-width site"`);
		expect(lines[2]).toContain(`"'=HYPERLINK(""https://evil.example"")"`);
		expect(lines[2]).toContain(`"'+Plus site"`);
	});

	test("follows the same rules as reading", async () => {
		const owner = await install.createMember({ workspaceId: acme, role: "owner" });
		const editor = await install.createMember({ workspaceId: acme, role: "editor" });

		expect((await owner.browser.api.audit.export({ workspaceId: acme })).csv).toContain('"site.create"');
		await expect(editor.browser.api.audit.export({ workspaceId: acme })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.browser.api.audit.export({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("entries never change", () => {
	test("no procedure writes, changes or deletes one", async () => {
		for (const path of ["audit/delete", "audit/update", "audit/remove", "audit/record", "audit/clear"]) {
			const response = await install.request(install.adminUrl(`/api/rpc/${path}`), {
				method: "POST",
				headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
				body: JSON.stringify({ json: {} }),
			});
			expect(response.status).toBe(404);
		}
	});

	test("Audit log reads are the admin's own: API tokens can't read it", async () => {
		const token = await createApiToken(staff.browser, { name: "Reader", workspaceId: acme });

		const response = await tokenClient(install, token.secret).request("/audit/list", {
			method: "POST",
			body: JSON.stringify({ workspaceId: acme }),
		});

		expect(response.status).toBe(404);
	});
});
