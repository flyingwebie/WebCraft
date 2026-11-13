// A Site's Consent banner setting (ADR 0020): Opt-in (the default), Opt-out, None or an outside
// consent service, and the banner's layout. It is a Site setting: Staff change it, it applies at once
// and is logged; everyone who sees the Site reads it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let owner: TestBrowser;
let author: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

async function newSite(): Promise<string> {
	return (await install.createSite(workspaceId, { name: "Bakery", slug: `settings-${++sites}` })).id;
}

describe("the Consent banner setting", () => {
	test("a new Site asks for consent before anything is held back is loaded: Opt-in, as a bottom bar", async () => {
		const siteId = await newSite();

		const { banner } = await author.api.consentBanner.get({ siteId });

		expect(banner).toMatchObject({ mode: "optIn", layout: "bar", version: 1 });
	});

	test("Staff change the mode and the layout: it applies at once, each change is logged and makes a new banner version", async () => {
		const siteId = await newSite();

		const changed = await staff.api.consentBanner.setSettings({ siteId, mode: "optOut", layout: "dialog" });
		expect(changed.banner).toMatchObject({ mode: "optOut", layout: "dialog", version: 2 });
		await staff.api.consentBanner.setSettings({ siteId, mode: "outside", layout: "dialog" });
		// Saving what is already there changes nothing.
		await staff.api.consentBanner.setSettings({ siteId, mode: "outside", layout: "dialog" });

		expect((await owner.api.consentBanner.get({ siteId })).banner).toMatchObject({
			mode: "outside",
			layout: "dialog",
			version: 3,
		});
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		const ours = entries
			.filter((entry) => entry.siteId === siteId && entry.action.startsWith("consentBanner."))
			.map((entry) => [entry.action, entry.details]);
		expect(ours).toEqual([
			["consentBanner.change", { mode: { from: "optOut", to: "outside" } }],
			["consentBanner.change", { mode: { from: "optIn", to: "optOut" }, layout: { from: "bar", to: "dialog" } }],
		]);
	});

	test("only Staff change it: Members are refused", async () => {
		const siteId = await newSite();

		for (const member of [owner, author]) {
			await expect(member.api.consentBanner.setSettings({ siteId, mode: "none", layout: "bar" })).rejects.toMatchObject(
				{
					code: "FORBIDDEN",
				},
			);
		}
		expect((await staff.api.consentBanner.get({ siteId })).banner.mode).toBe("optIn");
	});

	test("an unknown mode or layout is refused", async () => {
		const siteId = await newSite();

		await expect(
			staff.api.consentBanner.setSettings({ siteId, mode: "sometimes" as never, layout: "bar" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			staff.api.consentBanner.setSettings({ siteId, mode: "none", layout: "sidebar" as never }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
