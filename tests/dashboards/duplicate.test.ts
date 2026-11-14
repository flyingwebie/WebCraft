// Duplicating a Widget (UI overhaul, SPEC 14.3 and D11): the copy keeps the Widget's kind, title,
// range, filters, settings and rows at its size, and lands in the first free place, as a new one does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-16T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("duplicating a Widget", () => {
	test("keeps everything it shows and lands in the first free place", async () => {
		const { id: siteId } = await install.createSite(workspaceId);
		const { dashboard } = await staff.api.dashboards.create({ siteId, name: "Campaigns" });
		const dashboardId = dashboard.id;
		const { widgetId } = await staff.api.dashboards.widgets.add({
			siteId,
			dashboardId,
			kind: "site-analytics:top-pages",
			title: "Spring pages",
			range: { preset: "custom", from: "2026-03-01", to: "2026-03-10" },
			filters: { source: "newsletter", device: "mobile" },
			rows: 20,
			w: 4,
			h: 3,
		});
		await staff.api.dashboards.widgets.add({ siteId, dashboardId, kind: "note", settings: { text: "Hello" } });

		const copied = await staff.api.dashboards.widgets.duplicate({ siteId, dashboardId, widgetId });
		expect(copied.widgetId).not.toBe(widgetId);
		const original = copied.dashboard.widgets.find((widget) => widget.id === widgetId);
		const copy = copied.dashboard.widgets.find((widget) => widget.id === copied.widgetId);
		const { id: _a, x: _ax, y: _ay, ...kept } = original ?? ({} as NonNullable<typeof original>);
		const { id: _b, x, y, ...given } = copy ?? ({} as NonNullable<typeof copy>);
		expect(given).toEqual(kept);
		expect(given).toMatchObject({
			kind: "site-analytics:top-pages",
			title: "Spring pages",
			range: { preset: "custom", from: "2026-03-01", to: "2026-03-10" },
			filters: { source: "newsletter", device: "mobile" },
			rows: 20,
			w: 4,
			h: 3,
		});
		// The original sits at 0,0 (4 wide), the note beside it at 4,0 (4 wide): the copy takes 8,0.
		expect({ x, y }).toEqual({ x: 8, y: 0 });
		expect(copied.dashboard.widgets.map((widget) => widget.kind)).toEqual([
			"site-analytics:top-pages",
			"note",
			"site-analytics:top-pages",
		]);

		// A copy is a Widget of its own: changing it leaves the original as it was.
		const changed = await staff.api.dashboards.widgets.update({
			siteId,
			dashboardId,
			widgetId: copied.widgetId,
			title: "Autumn pages",
		});
		expect(changed.dashboard.widgets.map((widget) => widget.title)).toEqual(["Spring pages", null, "Autumn pages"]);

		// A note keeps its words, and its copy takes the first place free of the others: under the note.
		const note = changed.dashboard.widgets[1]?.id ?? "";
		const notes = await staff.api.dashboards.widgets.duplicate({ siteId, dashboardId, widgetId: note });
		expect(notes.dashboard.widgets.find((widget) => widget.id === notes.widgetId)).toMatchObject({
			kind: "note",
			settings: { text: "Hello" },
			x: 4,
			y: 2,
		});
	});

	test("works on a Workspace Dashboard, refuses a Widget that isn't there, a full Dashboard, and non-Staff", async () => {
		const { dashboard } = await staff.api.dashboards.create({ workspaceId, name: "All Sites" });
		const place = { workspaceId, dashboardId: dashboard.id };
		const { widgetId } = await staff.api.dashboards.widgets.add({ ...place, kind: "site-analytics:totals" });

		const copied = await staff.api.dashboards.widgets.duplicate({ ...place, widgetId });
		expect(copied.dashboard.widgets.map(({ kind, x, y, w, h }) => [kind, x, y, w, h])).toEqual([
			["site-analytics:totals", 0, 0, 6, 2],
			["site-analytics:totals", 6, 0, 6, 2],
		]);

		await expect(
			staff.api.dashboards.widgets.duplicate({ ...place, widgetId: crypto.randomUUID() }),
		).rejects.toMatchObject({ code: "WIDGET_NOT_FOUND" });

		for (let count = 2; count < 40; count++) await staff.api.dashboards.widgets.add({ ...place, kind: "note" });
		await expect(staff.api.dashboards.widgets.duplicate({ ...place, widgetId })).rejects.toMatchObject({
			code: "DASHBOARD_INVALID",
			data: { problem: "widgets" },
		});

		const { id: siteId } = await install.createSite(workspaceId);
		const owner = (await install.createMember({ workspaceId, role: "owner", sites: "all" })).browser;
		const { dashboard: board } = await staff.api.dashboards.create({ siteId, name: "Mine" });
		const added = await staff.api.dashboards.widgets.add({ siteId, dashboardId: board.id, kind: "note" });
		await expect(
			owner.api.dashboards.widgets.duplicate({ siteId, dashboardId: board.id, widgetId: added.widgetId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
