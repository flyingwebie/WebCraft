// Domains (ADR 0015): Staff add a Site's domains in Site settings; each is unique on the Install, kept
// in lower case and in its ASCII form, and never one of the Install's own names. The admin shows the
// DNS records to create: A/AAAA records to the Install's addresses, or a CNAME to the admin host.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, TEST_INSTALL_ADDRESSES, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let admin: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
});

afterAll(async () => {
	await install.close();
});

describe("adding a domain", () => {
	test("Staff add a domain; it waits for DNS, and the admin shows the records to create", async () => {
		const { id: siteId } = await install.createSite(workspaceId);
		const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;

		const { domains } = await staff.api.domains.add({ siteId, name: "AcmeBakery.ie." });

		expect(domains).toEqual([
			expect.objectContaining({ name: "acmebakery.ie", role: "primary", status: "waiting", language: null }),
		]);
		const listed = await staff.api.domains.list({ siteId });
		expect(listed.edge).toBe("caddy");
		expect(listed.domains).toHaveLength(1);
		expect(listed.domains[0]?.records).toEqual({
			address: [
				{ type: "A", name: "acmebakery.ie", value: TEST_INSTALL_ADDRESSES[0] },
				{ type: "AAAA", name: "acmebakery.ie", value: TEST_INSTALL_ADDRESSES[1] },
			],
			alias: { type: "CNAME", name: "acmebakery.ie", value: install.adminHost },
		});
	});

	test("the first domain is the Primary domain; later ones are Redirect domains", async () => {
		const { id: siteId } = await install.createSite(workspaceId);

		await admin.api.domains.add({ siteId, name: "first-bakery.example" });
		await admin.api.domains.add({ siteId, name: "old-bakery.example" });
		await admin.api.domains.add({ siteId, name: "bakery-shop.example" });

		const { domains } = await admin.api.domains.list({ siteId });
		expect(domains.map(({ name, role }) => [name, role])).toEqual([
			["first-bakery.example", "primary"],
			["bakery-shop.example", "redirect"],
			["old-bakery.example", "redirect"],
		]);
	});

	test("apex and www come together when asked: the one typed, and the other as a Redirect domain", async () => {
		const apexFirst = (await install.createSite(workspaceId)).id;
		const wwwFirst = (await install.createSite(workspaceId)).id;

		const apex = await admin.api.domains.add({ siteId: apexFirst, name: "twin-bakery.example", withPartner: true });
		const www = await admin.api.domains.add({ siteId: wwwFirst, name: "www.twin-cafe.example", withPartner: true });

		expect(apex.domains.map(({ name, role }) => [name, role])).toEqual([
			["twin-bakery.example", "primary"],
			["www.twin-bakery.example", "redirect"],
		]);
		expect(www.domains.map(({ name, role }) => [name, role])).toEqual([
			["www.twin-cafe.example", "primary"],
			["twin-cafe.example", "redirect"],
		]);
	});

	test("a partner the Site already has is left as it is", async () => {
		const { id: siteId } = await install.createSite(workspaceId);
		await admin.api.domains.add({ siteId, name: "www.pair-bakery.example" });

		const { domains } = await admin.api.domains.add({ siteId, name: "pair-bakery.example", withPartner: true });

		expect(domains.map(({ name }) => name)).toEqual(["pair-bakery.example"]);
		expect((await admin.api.domains.list({ siteId })).domains).toHaveLength(2);
	});

	test("an international domain is kept in its ASCII form, and shown as written", async () => {
		const { id: siteId } = await install.createSite(workspaceId);

		const { domains } = await admin.api.domains.add({ siteId, name: "Bäckerei-Müller.example" });

		expect(domains[0]).toMatchObject({
			name: "xn--bckerei-mller-bfb28a.example",
			displayName: "bäckerei-müller.example",
		});
	});
});

describe("domains Staff can't add", () => {
	test("a domain is unique on the Install: another Site, even in another Workspace, can't add it", async () => {
		const first = (await install.createSite(workspaceId)).id;
		const otherWorkspace = (await install.createWorkspace()).id;
		const second = (await install.createSite(otherWorkspace)).id;
		await admin.api.domains.add({ siteId: first, name: "unique-bakery.example" });

		for (const [siteId, name] of [
			[second, "UNIQUE-bakery.example"],
			[first, "unique-bakery.example"],
		] as const) {
			await expect(admin.api.domains.add({ siteId, name })).rejects.toMatchObject({
				code: "DOMAIN_TAKEN",
				status: 409,
				data: { name: "unique-bakery.example" },
			});
		}
	});

	test("a partner another Site has refuses the whole addition", async () => {
		const first = (await install.createSite(workspaceId)).id;
		const second = (await install.createSite(workspaceId)).id;
		await admin.api.domains.add({ siteId: first, name: "www.shared-bakery.example" });

		await expect(
			admin.api.domains.add({ siteId: second, name: "shared-bakery.example", withPartner: true }),
		).rejects.toMatchObject({ code: "DOMAIN_TAKEN", data: { name: "www.shared-bakery.example" } });
		expect((await admin.api.domains.list({ siteId: second })).domains).toEqual([]);
	});

	test("a language's own domain is taken too, and a domain a Site has can't become a language's", async () => {
		const { id: siteId } = await install.createSite(workspaceId);
		await admin.api.languages.add({ siteId, code: "fr", domain: "bakery-lang.example" });
		await admin.api.domains.add({ siteId, name: "bakery-main.example" });

		await expect(admin.api.domains.add({ siteId, name: "bakery-lang.example" })).rejects.toMatchObject({
			code: "DOMAIN_TAKEN",
		});
		await expect(admin.api.languages.add({ siteId, code: "de", domain: "bakery-main.example" })).rejects.toMatchObject({
			code: "LANGUAGE_TAKEN",
			data: { field: "domain" },
		});
	});

	test("refuses what isn't a domain, and the Install's own names", async () => {
		const { id: siteId } = await install.createSite(workspaceId);

		for (const name of ["not a domain", "https://bakery.example/", "bakery", "203.0.113.7", "*.bakery.example", ""]) {
			await expect(admin.api.domains.add({ siteId, name })).rejects.toMatchObject({
				code: "DOMAIN_INVALID",
				data: { reason: "format" },
			});
		}
		for (const name of [install.adminHost, "sites.test", "bakery.sites.test", "deeper.bakery.sites.test"]) {
			await expect(admin.api.domains.add({ siteId, name })).rejects.toMatchObject({
				code: "DOMAIN_INVALID",
				data: { reason: "install" },
			});
		}
		expect((await admin.api.domains.list({ siteId })).domains).toEqual([]);
	});
});

describe("who sees and changes domains", () => {
	test("everyone who sees the Site sees its domains; only Staff change them", async () => {
		const { id: siteId } = await install.createSite(workspaceId);
		await admin.api.domains.add({ siteId, name: "members-bakery.example" });

		for (const role of ["owner", "editor", "author"] as const) {
			const member = (await install.createMember({ workspaceId, role })).browser;
			const { domains } = await member.api.domains.list({ siteId });
			expect(domains.map(({ name }) => name)).toEqual(["members-bakery.example"]);
			await expect(member.api.domains.add({ siteId, name: `${role}-bakery.example` })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
	});

	test("adding a domain is recorded in the Audit log", async () => {
		const { id: siteId } = await install.createSite(workspaceId);

		await admin.api.domains.add({ siteId, name: "logged-bakery.example", withPartner: true });

		const { entries } = await admin.api.audit.list({});
		const added = entries.filter((entry) => entry.action === "domain.add" && entry.siteId === siteId);
		expect(added.map((entry) => entry.details)).toEqual([
			{ names: ["logged-bakery.example", "www.logged-bakery.example"] },
		]);
	});
});
