// Reading the Audit log: who sees which entries at each level, its filters and its pages.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestBrowser;
let acme: string;
let nimbus: string;
let bakery: string;
let catering: string;
let shop: string;
let staff: { personId: string; browser: TestBrowser };
let owner: { personId: string; browser: TestBrowser };
let bakeryOwner: { personId: string; browser: TestBrowser };
let editor: { personId: string; browser: TestBrowser };

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.superadmin();
	acme = (await install.createWorkspace("Acme Ltd")).id;
	nimbus = (await install.createWorkspace("Nimbus Bikes")).id;
	bakery = (await install.createSite(acme, { name: "Acme Bakery", slug: "bakery" })).id;
	catering = (await install.createSite(acme, { name: "Acme Catering", slug: "catering" })).id;
	shop = (await install.createSite(nimbus, { name: "Nimbus Shop", slug: "shop" })).id;
	staff = await install.createStaff({ workspaces: [acme], name: "Agency Anna" });
	owner = await install.createMember({ workspaceId: acme, role: "owner", name: "Olive Owner" });
	bakeryOwner = await install.createMember({ workspaceId: acme, role: "owner", sites: [bakery], name: "Bea Baker" });
	editor = await install.createMember({ workspaceId: acme, role: "editor", name: "Eddie Editor" });
});

afterAll(async () => {
	await install.close();
});

/** Every entry a browser may read at a level, following every page. */
async function everything(browser: TestBrowser, input: { workspaceId?: string } = {}) {
	const all = [];
	let after: string | undefined;
	for (;;) {
		const page = await browser.api.audit.list({ ...input, limit: 200, ...(after ? { after } : {}) });
		all.push(...page.entries);
		if (!page.next) return all;
		after = page.next;
	}
}

describe("who sees which entries", () => {
	test("the Superadmin sees the whole Install, its own entries too", async () => {
		const entries = await everything(superadmin);

		const workspaces = new Set(entries.map((entry) => entry.workspaceId));
		expect(workspaces).toContain(acme);
		expect(workspaces).toContain(nimbus);
		// Inviting Staff is about the Install, not a Workspace.
		expect(entries.find((entry) => entry.action === "staff.invite")?.workspaceId).toBeNull();
	});

	test("Staff see a Workspace they reach, and nothing of one they don't", async () => {
		const entries = await everything(staff.browser, { workspaceId: acme });

		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.workspaceId === acme)).toBe(true);
		expect(entries.map((entry) => entry.siteId)).toEqual(expect.arrayContaining([bakery, catering]));
		expect(entries.map((entry) => entry.siteId)).not.toContain(shop);
		await expect(staff.browser.api.audit.list({ workspaceId: nimbus })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
	});

	test("Staff don't read the Install's own entries", async () => {
		await expect(staff.browser.api.audit.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("an Owner sees their own Workspace", async () => {
		const entries = await everything(owner.browser, { workspaceId: acme });

		expect(entries.every((entry) => entry.workspaceId === acme)).toBe(true);
		expect(entries.map((entry) => entry.action)).toEqual(expect.arrayContaining(["site.create", "member.join"]));
		await expect(owner.browser.api.audit.list({ workspaceId: nimbus })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
	});

	test("an Owner reaching some Sites never sees the entries of the others", async () => {
		const entries = await everything(bakeryOwner.browser, { workspaceId: acme });

		const sites = new Set(entries.map((entry) => entry.siteId));
		expect(sites).toContain(bakery);
		expect(sites).not.toContain(catering);
		// The Workspace's own entries (no Site) are theirs to see.
		expect(sites).toContain(null);
	});

	test("Editors and Authors read no Audit log", async () => {
		await expect(editor.browser.api.audit.list({ workspaceId: acme })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(editor.browser.api.audit.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("each page names the people, Workspaces and Sites its entries mention", async () => {
		const page = await owner.browser.api.audit.list({ workspaceId: acme, action: "member.join" });

		const joined = page.entries.find((entry) => entry.personId === owner.personId);
		expect(joined).toBeDefined();
		expect(page.people[owner.personId]).toEqual({ name: "Olive Owner", email: expect.stringContaining("@") });
		expect(page.workspaces[acme]).toBe("Acme Ltd");
		const created = await owner.browser.api.audit.list({ workspaceId: acme, action: "site.create" });
		expect(created.sites[bakery]).toBe("Acme Bakery");
	});
});
