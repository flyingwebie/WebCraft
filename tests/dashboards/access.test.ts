// Who sees Dashboards (#103): Staff build them; Owners see them all; Editors and Authors see only those
// Staff show to everyone who works on the Site. Everyone who sees a Dashboard can export its Widgets as
// CSV files (UTF-8 with a BOM, formulas made text), recorded in the Audit log.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsApi, analyticsVisitor, liveSite } from "../harness/analytics.ts";
import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-16T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

/** A live Site with a Dashboard of one Widget, Totals. */
async function siteWithDashboard() {
	const site = await liveSite(install, staff, workspaceId, `access-${++domains}.example`);
	await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	const { dashboard } = await staff.api.dashboards.create({ siteId: site.siteId, name: "Client board" });
	const { widgetId } = await staff.api.dashboards.widgets.add({
		siteId: site.siteId,
		dashboardId: dashboard.id,
		kind: "site-analytics:totals",
	});
	return { ...site, dashboardId: dashboard.id, widgetId };
}

describe("who sees a Dashboard", () => {
	test("Owners see every Dashboard and its data, but only Staff build them", async () => {
		const { siteId, dashboardId, widgetId } = await siteWithDashboard();
		const owner = (await install.createMember({ workspaceId, role: "owner", sites: [siteId] })).browser;

		expect((await owner.api.dashboards.list({ siteId })).dashboards.map((each) => each.name)).toEqual(["Client board"]);
		expect((await owner.api.dashboards.get({ siteId, dashboardId })).dashboard.canManage).toBe(false);
		expect((await owner.api.dashboards.widgets.data({ siteId, dashboardId, widgetId })).widget.problem).toBeNull();
		await expect(owner.api.dashboards.create({ siteId, name: "Mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.api.dashboards.widgets.add({ siteId, dashboardId, kind: "note" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(owner.api.dashboards.update({ siteId, dashboardId, sharedWithEveryone: true })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("Editors and Authors see only the Dashboards Staff show to everyone, and never change them", async () => {
		const { siteId, dashboardId, widgetId } = await siteWithDashboard();
		const { dashboard: hidden } = await staff.api.dashboards.create({ siteId, name: "Staff notes" });
		const editor = (await install.createMember({ workspaceId, role: "editor", sites: [siteId] })).browser;
		const author = (await install.createMember({ workspaceId, role: "author", sites: [siteId] })).browser;

		for (const member of [editor, author]) {
			expect((await member.api.dashboards.list({ siteId })).dashboards).toEqual([]);
			await expect(member.api.dashboards.get({ siteId, dashboardId })).rejects.toMatchObject({
				code: "DASHBOARD_NOT_FOUND",
			});
			await expect(member.api.dashboards.widgets.data({ siteId, dashboardId, widgetId })).rejects.toMatchObject({
				code: "DASHBOARD_NOT_FOUND",
			});
		}

		const shown = await staff.api.dashboards.update({ siteId, dashboardId, sharedWithEveryone: true });
		expect(shown.dashboard.sharedWithEveryone).toBe(true);

		for (const member of [editor, author]) {
			expect((await member.api.dashboards.list({ siteId })).dashboards.map((each) => each.name)).toEqual([
				"Client board",
			]);
			expect((await member.api.dashboards.widgets.data({ siteId, dashboardId, widgetId })).widget.data).toMatchObject({
				shape: "number",
			});
			await expect(member.api.dashboards.get({ siteId, dashboardId: hidden.id })).rejects.toMatchObject({
				code: "DASHBOARD_NOT_FOUND",
			});
			await expect(member.api.dashboards.widgets.remove({ siteId, dashboardId, widgetId })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
	});

	test("an API token reads and exports Dashboards; a read-only one never changes them", async () => {
		const { siteId, dashboardId, widgetId } = await siteWithDashboard();
		const { secret } = await createApiToken(staff, { workspaceId, name: "Reports", readOnly: true });
		const { api } = tokenClient(install, secret);

		expect((await api.dashboards.widgets.data({ siteId, dashboardId, widgetId })).widget.data).toMatchObject({
			shape: "number",
		});
		expect((await api.dashboards.export({ siteId, dashboardId })).csv).toContain("Totals");
		await expect(api.dashboards.widgets.remove({ siteId, dashboardId, widgetId })).rejects.toMatchObject({
			code: "TOKEN_READ_ONLY",
		});
	});
});

describe("CSV exports", () => {
	test("a Widget's file: UTF-8 with a BOM, every cell quoted, formulas made text, recorded in the Audit log", async () => {
		const site = await siteWithDashboard();
		const { siteId, dashboardId } = site;
		await analyticsApi(staff).goals.create({
			siteId,
			name: '=HYPERLINK("https://evil.example")',
			definition: { kind: "event", event: "signup" },
		});
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.81" });
		await visitor.view("/", { us: "+1-555-0100" });
		// The collection script sends the page's campaign with every event.
		await visitor.send({ t: "event", p: "/", n: "signup", us: "+1-555-0100" });
		const add = async (kind: string) =>
			(await staff.api.dashboards.widgets.add({ siteId, dashboardId, kind })).widgetId;
		const sources = await add("site-analytics:sources");
		const goals = await add("site-analytics:goals");

		const exported = await staff.api.dashboards.widgets.export({ siteId, dashboardId, widgetId: sources });
		expect(exported.filename).toBe("client-board-sources-2026-03-16.csv");
		expect(exported.csv).toBe(
			[
				'﻿"Sources"',
				'"Range (UTC)","2026-02-15 – 2026-03-16"',
				'"Source","Arrivals","Visitors"',
				`"'+1-555-0100","1","1"`,
				"",
			].join("\r\n"),
		);
		const goalFile = (await staff.api.dashboards.widgets.export({ siteId, dashboardId, widgetId: goals })).csv;
		expect(goalFile).toContain(`"'=HYPERLINK(""https://evil.example"")","1","1","100.0%"`);

		const whole = await staff.api.dashboards.export({ siteId, dashboardId });
		expect(whole.filename).toBe("client-board-2026-03-16.csv");
		const lines = whole.csv.split("\r\n");
		expect(lines[0]).toBe('﻿"Dashboard","Client board"');
		expect(lines.filter((line) => /^"(Totals|Sources|Goals)"$/.test(line))).toEqual([
			'"Totals"',
			'"Sources"',
			'"Goals"',
		]);
		expect(lines).toContain('"Page views","1","",""');

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		const exports = entries.filter((entry) => entry.action === "dashboard.export" && entry.siteId === siteId);
		expect(exports.map((entry) => entry.details)).toEqual([
			{ dashboardId, name: "Client board", widgets: 3 },
			{ dashboardId, name: "Client board", widgetId: goals, widget: "Goals" },
			{ dashboardId, name: "Client board", widgetId: sources, widget: "Sources" },
		]);
	});
});
