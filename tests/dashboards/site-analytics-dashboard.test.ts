// The built-in "Site analytics" Dashboard (UI overhaul, SPEC 14.1 and D10): every Site has one from
// the moment it is made, laid out on the 12-column grid, listed first. Staff arrange and rename it like
// any other, nobody deletes it, and it is shown to Staff and Owners until someone shows it to everyone.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsVisitor, liveSite } from "../harness/analytics.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-16T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.2.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const builtInOf = async (browser: TestBrowser, siteId: string) => {
	const { dashboards } = await browser.api.dashboards.list({ siteId });
	const found = dashboards.find((each) => each.builtIn);
	if (!found) throw new Error("The Site has no built-in Dashboard.");
	return found;
};

describe("the Site analytics Dashboard", () => {
	test("comes with every new Site: Totals, Over time beside Sources, Top pages beside Goals over Devices", async () => {
		const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery" });

		const { dashboards } = await staff.api.dashboards.list({ siteId });
		expect(dashboards).toEqual([
			expect.objectContaining({ name: "Site analytics", builtIn: true, widgets: 6, sharedWithEveryone: false }),
		]);
		const { dashboard } = await staff.api.dashboards.get({ siteId, dashboardId: dashboards[0]?.id ?? "" });
		expect(dashboard).toMatchObject({ name: "Site analytics", builtIn: true, range: { preset: "last30Days" } });
		expect(
			dashboard.widgets.map(({ kind, x, y, w, h, title, range, filters }) => ({
				kind,
				x,
				y,
				w,
				h,
				title,
				range,
				filters,
			})),
		).toEqual([
			{ kind: "site-analytics:totals", x: 0, y: 0, w: 12, h: 2, title: null, range: null, filters: {} },
			{ kind: "site-analytics:trend", x: 0, y: 2, w: 8, h: 4, title: null, range: null, filters: {} },
			{ kind: "site-analytics:sources", x: 8, y: 2, w: 4, h: 4, title: null, range: null, filters: {} },
			{ kind: "site-analytics:top-pages", x: 0, y: 6, w: 6, h: 4, title: null, range: null, filters: {} },
			{ kind: "site-analytics:goals", x: 6, y: 6, w: 6, h: 2, title: null, range: null, filters: {} },
			{ kind: "site-analytics:devices", x: 6, y: 8, w: 6, h: 2, title: null, range: null, filters: {} },
		]);
		// Its Widgets read as any Widget added from the catalog does: the kinds' own settings.
		expect(dashboard.widgets[0]?.settings).toEqual({ measures: ["pageviews", "visitors", "visits", "events"] });
		expect(dashboard.widgets[1]?.settings).toEqual({ measures: ["pageviews", "visitors"] });
		expect(new Set(dashboard.widgets.map((widget) => widget.id)).size).toBe(6);
	});

	test("counts the Site's visits like any Dashboard", async () => {
		const site = await liveSite(install, staff, workspaceId, `built-in-${++domains}.example`);
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
		await analyticsVisitor(install, site.origin, { address: "203.0.113.81" }).view("/");

		const board = await builtInOf(staff, site.siteId);
		const { dashboard } = await staff.api.dashboards.get({ siteId: site.siteId, dashboardId: board.id });
		const totals = dashboard.widgets[0]?.id ?? "";
		const { widget } = await staff.api.dashboards.widgets.data({
			siteId: site.siteId,
			dashboardId: board.id,
			widgetId: totals,
		});
		expect(widget).toMatchObject({
			title: "Totals",
			problem: null,
			data: { shape: "number", values: [{ key: "pageviews", count: 1 }, { key: "visitors", count: 1 }, {}, {}] },
		});
	});

	test("is listed first, and is arranged and renamed like any other", async () => {
		const { id: siteId } = await install.createSite(workspaceId, { name: "Florist" });
		await staff.api.dashboards.create({ siteId, name: "A first look" });
		const board = await builtInOf(staff, siteId);

		const { dashboard } = await staff.api.dashboards.get({ siteId, dashboardId: board.id });
		const devices = dashboard.widgets[5]?.id ?? "";
		const moved = await staff.api.dashboards.widgets.move({
			siteId,
			dashboardId: board.id,
			widgetId: devices,
			x: 0,
			y: 0,
			w: 12,
			h: 2,
		});
		expect(moved.dashboard.widgets.find((widget) => widget.id === devices)).toMatchObject({ x: 0, y: 0, w: 12 });
		const { widgetId: note } = await staff.api.dashboards.widgets.add({ siteId, dashboardId: board.id, kind: "note" });
		await staff.api.dashboards.widgets.remove({ siteId, dashboardId: board.id, widgetId: note });

		const renamed = await staff.api.dashboards.update({ siteId, dashboardId: board.id, name: "Zest numbers" });
		expect(renamed.dashboard).toMatchObject({ name: "Zest numbers", builtIn: true });
		expect(
			(await staff.api.dashboards.list({ siteId })).dashboards.map(({ name, builtIn }) => [name, builtIn]),
		).toEqual([
			["Zest numbers", true],
			["A first look", false],
		]);
	});

	test("can't be deleted: the API says why, and the Dashboard stays", async () => {
		const { id: siteId } = await install.createSite(workspaceId, { name: "Butcher" });
		const board = await builtInOf(staff, siteId);

		expect(await rejection(staff.api.dashboards.delete({ siteId, dashboardId: board.id }))).toMatchObject({
			code: "DASHBOARD_INVALID",
			status: 400,
			data: { problem: "builtIn" },
			message: expect.stringContaining("built in"),
		});
		expect((await staff.api.dashboards.list({ siteId })).dashboards.map((each) => each.id)).toEqual([board.id]);

		// Any other Dashboard still goes.
		const { dashboard: other } = await staff.api.dashboards.create({ siteId, name: "Spare" });
		await staff.api.dashboards.delete({ siteId, dashboardId: other.id });
		expect((await staff.api.dashboards.list({ siteId })).dashboards.map((each) => each.id)).toEqual([board.id]);
	});

	test("is shown to Staff and Owners until someone shows it to everyone", async () => {
		const { id: siteId } = await install.createSite(workspaceId, { name: "Grocer" });
		const owner = (await install.createMember({ workspaceId, role: "owner", sites: [siteId] })).browser;
		const editor = (await install.createMember({ workspaceId, role: "editor", sites: [siteId] })).browser;
		const board = await builtInOf(staff, siteId);

		expect((await builtInOf(owner, siteId)).id).toBe(board.id);
		expect((await editor.api.dashboards.list({ siteId })).dashboards).toEqual([]);

		await staff.api.dashboards.update({ siteId, dashboardId: board.id, sharedWithEveryone: true });
		expect((await editor.api.dashboards.list({ siteId })).dashboards).toEqual([
			expect.objectContaining({ id: board.id, builtIn: true, sharedWithEveryone: true }),
		]);
	});
});
