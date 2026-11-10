// A Site import's domains arrive paused (ADR 0033): they serve nothing and aren't checked, since the Site
// they came from may still have them and their DNS may not point here yet. Staff switch each on once it
// is free, and it is added and verified like any new domain; or they discard it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let newSiteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const otherWorkspaceId = (await install.createWorkspace("Beta Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId, otherWorkspaceId] })).browser;
	await staff.api.domains.add({ siteId, name: "acmebakery.example", withPartner: true });
	await staff.api.languages.add({ siteId, code: "it", domain: "acmebakery.it" });
	const archive = await exportedArchive(install, staff, siteId);
	const imported = await importArchive(install, staff, otherWorkspaceId, archive, { name: "Beta", slug: "beta" });
	expect(imported.status).toBe("done");
	newSiteId = imported.site?.id ?? "";
});

afterAll(async () => {
	await install?.close();
});

describe("a Site import's domains", () => {
	test("arrive paused, off the domain list, as the Site import report says", async () => {
		const { paused } = await staff.api.domains.paused({ siteId: newSiteId });
		expect(paused.map((domain) => [domain.name, domain.role, domain.language])).toEqual([
			["acmebakery.example", "primary", null],
			["acmebakery.it", "language", "it"],
			["www.acmebakery.example", "redirect", null],
		]);
		expect((await staff.api.domains.list({ siteId: newSiteId })).domains).toEqual([]);
		const { languages } = (await staff.api.languages.list({ siteId: newSiteId })).settings;
		expect(languages.find((language) => language.code === "it")?.domain).toBeNull();
	});

	test("can't be switched on while another Site of the Install has them", async () => {
		const { paused } = await staff.api.domains.paused({ siteId: newSiteId });
		const primary = paused.find((domain) => domain.role === "primary");
		await expect(
			staff.api.domains.switchOnPaused({ siteId: newSiteId, pausedId: primary?.id ?? "" }),
		).rejects.toMatchObject({
			code: "DOMAIN_TAKEN",
		});
		expect((await staff.api.domains.paused({ siteId: newSiteId })).paused).toHaveLength(3);
	});

	test("switched on once free, a domain is added and verified like any new one", async () => {
		const { domains } = await staff.api.domains.list({ siteId });
		const primary = domains.find((domain) => domain.name === "acmebakery.example");
		const asked = await staff.api.domains.remove({ siteId, domainId: primary?.id ?? "" });
		await staff.api.domains.remove({
			siteId,
			domainId: primary?.id ?? "",
			confirmation: (asked as { confirmation?: { id: string } }).confirmation?.id,
		});
		const { paused } = await staff.api.domains.paused({ siteId: newSiteId });
		const switched = await staff.api.domains.switchOnPaused({
			siteId: newSiteId,
			pausedId: paused.find((domain) => domain.name === "acmebakery.example")?.id ?? "",
		});
		expect(switched.domains.map((domain) => [domain.name, domain.role, domain.status])).toEqual([
			["acmebakery.example", "primary", "waiting"],
		]);
		expect(switched.paused.map((domain) => domain.name)).toEqual(["acmebakery.it", "www.acmebakery.example"]);

		install.connectDomain("acmebakery.example");
		const added = switched.domains[0];
		const checked = await staff.api.domains.check({ siteId: newSiteId, domainId: added?.id ?? "" });
		expect(checked.domain.status).toBe("active");
	});

	test("a language's domain becomes that language's again", async () => {
		await staff.api.languages.update({ siteId, code: "it", domain: null });
		const { paused } = await staff.api.domains.paused({ siteId: newSiteId });
		await staff.api.domains.switchOnPaused({
			siteId: newSiteId,
			pausedId: paused.find((domain) => domain.role === "language")?.id ?? "",
		});
		const { languages } = (await staff.api.languages.list({ siteId: newSiteId })).settings;
		expect(languages.find((language) => language.code === "it")?.domain).toBe("acmebakery.it");
		const { domains } = await staff.api.domains.list({ siteId: newSiteId });
		expect(domains.map((domain) => [domain.name, domain.role])).toContainEqual(["acmebakery.it", "language"]);
	});

	test("one the Site won't use here can be discarded", async () => {
		const { paused } = await staff.api.domains.paused({ siteId: newSiteId });
		const { paused: left } = await staff.api.domains.discardPaused({
			siteId: newSiteId,
			pausedId: paused[0]?.id ?? "",
		});
		expect(left).toEqual([]);
	});

	test("Members may not see or switch them", async () => {
		const owner = (
			await install.createMember({
				workspaceId: (await staff.api.sites.get({ siteId: newSiteId })).site.workspaceId,
				role: "owner",
			})
		).browser;
		await expect(owner.api.domains.paused({ siteId: newSiteId })).rejects.toMatchObject({ status: 403 });
	});
});
