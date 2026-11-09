// Sites: the websites of a Workspace. Staff (and the Superadmin) create them; each has a slug that
// is unique on the Install, because its Staging address is `<slug>.<sites domain>`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let acme: string;
let nimbus: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	acme = (await install.createWorkspace("Acme Ltd")).id;
	nimbus = (await install.createWorkspace("Nimbus Bikes")).id;
	staff = (await install.createStaff({ workspaces: [acme] })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("creating Sites", () => {
	test("Staff create a Site in a Workspace they are assigned to, and it is listed there", async () => {
		const { site } = await staff.api.sites.create({ workspaceId: acme, name: " Acme Bakery ", slug: "Bakery" });

		expect(site).toEqual({
			id: expect.any(String),
			workspaceId: acme,
			name: "Acme Bakery",
			slug: "bakery",
			createdAt: install.clock.now(),
		});
		expect((await staff.api.sites.list({ workspaceId: acme })).sites).toContainEqual(site);
		expect(await staff.api.sites.get({ siteId: site.id })).toMatchObject({
			site,
			workspace: { id: acme, name: "Acme Ltd" },
		});
		const listed = (await admin.api.workspaces.list()).workspaces.find((workspace) => workspace.id === acme);
		expect(listed?.siteCount).toBeGreaterThanOrEqual(1);
	});

	test("the Superadmin creates Sites in any Workspace", async () => {
		const { site } = await admin.api.sites.create({ workspaceId: nimbus, name: "Nimbus Shop", slug: "nimbus-shop" });

		expect((await admin.api.sites.list({ workspaceId: nimbus })).sites.map((listed) => listed.id)).toEqual([site.id]);
	});

	test("Staff can't create Sites in a Workspace they aren't assigned to, nor see its Sites", async () => {
		await expect(staff.api.sites.create({ workspaceId: nimbus, name: "Sneaky", slug: "sneaky" })).rejects.toMatchObject(
			{ code: "WORKSPACE_NOT_FOUND" },
		);
		await expect(staff.api.sites.list({ workspaceId: nimbus })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
	});

	test("refuses a Site without a name", async () => {
		await expect(staff.api.sites.create({ workspaceId: acme, name: " ", slug: "nameless" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
});

describe("Site slugs", () => {
	test("are unique on the Install, across Workspaces", async () => {
		await admin.api.sites.create({ workspaceId: acme, name: "Careers", slug: "careers" });

		await expect(
			admin.api.sites.create({ workspaceId: nimbus, name: "Careers", slug: "careers" }),
		).rejects.toMatchObject({ code: "SLUG_TAKEN" });
		await expect(
			admin.api.sites.create({ workspaceId: acme, name: "Careers", slug: " CAREERS " }),
		).rejects.toMatchObject({ code: "SLUG_TAKEN" });
	});

	test("are lower-case letters, digits and dashes, at most 63, starting and ending with a letter or digit", async () => {
		for (const slug of ["", "-bakery", "bakery-", "two words", "bäckerei", "a.b", "x".repeat(64)]) {
			await expect(admin.api.sites.create({ workspaceId: acme, name: "Bad", slug })).rejects.toMatchObject({
				code: "SLUG_INVALID",
				data: { problem: "shape" },
			});
		}
		for (const slug of ["a", "7", "acme-catering-2", "x".repeat(63)]) {
			const { site } = await admin.api.sites.create({ workspaceId: acme, name: "Good", slug });
			expect(site.slug).toBe(slug);
		}
	});

	test("can't be a name the Install keeps for itself", async () => {
		for (const slug of ["admin", "www"]) {
			await expect(admin.api.sites.create({ workspaceId: acme, name: "Reserved", slug })).rejects.toMatchObject({
				code: "SLUG_INVALID",
				data: { problem: "reserved" },
			});
		}
	});
});

describe("the Audit log", () => {
	test("records who created the Site, in which Workspace, when and how", async () => {
		const { person } = await staff.api.session.current();

		const { site } = await staff.api.sites.create({ workspaceId: acme, name: "Acme Catering", slug: "catering" });

		const { entries } = await admin.api.audit.list({ limit: 1 });
		expect(entries).toEqual([
			{
				id: expect.any(String),
				at: install.clock.now(),
				action: "site.create",
				personId: person?.id ?? null,
				via: { kind: "admin" } as const,
				workspaceId: acme,
				siteId: site.id,
				details: { name: "Acme Catering", slug: "catering" },
			},
		]);
	});
});

describe("opening a Site", () => {
	test("a Site that doesn't exist is not found", async () => {
		await expect(admin.api.sites.get({ siteId: crypto.randomUUID() })).rejects.toMatchObject({
			code: "SITE_NOT_FOUND",
		});
	});

	test("a Site answers its languages: the Default language first", async () => {
		const { site } = await admin.api.sites.create({ workspaceId: acme, name: "Acme Deli", slug: "deli" });
		expect((await staff.api.sites.get({ siteId: site.id })).languages).toEqual({ default: "en", all: ["en"] });

		await staff.api.languages.add({ siteId: site.id, code: "fr" });

		expect((await staff.api.sites.get({ siteId: site.id })).languages).toEqual({ default: "en", all: ["en", "fr"] });
	});

	test("people who aren't signed in can't list, open or create Sites", async () => {
		const browser = install.browser();

		await expect(browser.api.sites.list({ workspaceId: acme })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(browser.api.sites.create({ workspaceId: acme, name: "X", slug: "x" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});
