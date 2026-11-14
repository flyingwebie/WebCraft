// The period before (UI overhaul, SPEC 14.2 "Compare", D11): a Widget that shows a number or lines
// over time (Totals, Over time, One Goal) can answer, beside its own range, the same figures for the
// period of the same length just before it, when the request asks (`compare`). A custom range works the
// same way; a request that doesn't ask gets exactly what it got before.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsVisitor, liveSite } from "../harness/analytics.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let siteId: string;
let dashboardId: string;
const widgets: Record<"totals" | "trend" | "pages" | "note" | "ownRange", string> = {
	totals: "",
	trend: "",
	pages: "",
	note: "",
	ownRange: "",
};

const day = (text: string) => new Date(`${text}T00:00:00Z`);

beforeAll(async () => {
	// A Monday at 09:00 UTC. The visits are sent with the clock set back to when each happened.
	install = await createTestInstall({ now: new Date("2026-03-16T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const site = await liveSite(install, staff, workspaceId, "before.example");
	siteId = site.siteId;
	await staff.api.consentBanner.setSettings({ siteId, mode: "none", layout: "bar" });

	const visit = async (at: string, address: string) => {
		await install.clock.set(new Date(at));
		await analyticsVisitor(install, site.origin, { address }).view("/");
	};
	await visit("2026-02-10T12:00:00Z", "203.0.113.91");
	await visit("2026-03-05T12:00:00Z", "203.0.113.92");
	await visit("2026-03-09T12:00:00Z", "203.0.113.93");
	await visit("2026-03-15T12:00:00Z", "203.0.113.94");
	await visit("2026-03-16T08:00:00Z", "203.0.113.95");
	await visit("2026-03-16T08:30:00Z", "198.51.100.96");
	await install.clock.set(new Date("2026-03-16T09:00:00Z"));

	const { dashboard } = await staff.api.dashboards.create({ siteId, name: "Compared" });
	dashboardId = dashboard.id;
	const add = async (input: Omit<Parameters<typeof staff.api.dashboards.widgets.add>[0], "siteId" | "dashboardId">) =>
		(await staff.api.dashboards.widgets.add({ siteId, dashboardId, ...input })).widgetId;
	widgets.totals = await add({ kind: "site-analytics:totals", settings: { measures: ["pageviews", "visitors"] } });
	widgets.trend = await add({ kind: "site-analytics:trend", settings: { measures: ["pageviews"] } });
	widgets.pages = await add({ kind: "site-analytics:top-pages" });
	widgets.note = await add({ kind: "note", settings: { text: "Spring" } });
	widgets.ownRange = await add({
		kind: "site-analytics:totals",
		settings: { measures: ["pageviews"] },
		range: { preset: "custom", from: "2026-03-09", to: "2026-03-15" },
	});
});

afterAll(async () => {
	await install.close();
});

type Range = Parameters<typeof staff.api.dashboards.widgets.data>[0]["range"];
const data = async (widgetId: string, options: { range?: Range; compare?: boolean } = {}) =>
	(await staff.api.dashboards.widgets.data({ siteId, dashboardId, widgetId, ...options })).widget;

describe("the period before", () => {
	test("Totals: the Dashboard's range, and the days of the same length just before it", async () => {
		const widget = await data(widgets.totals, { compare: true });
		expect(widget).toMatchObject({
			range: { from: day("2026-02-15"), to: day("2026-03-17"), interval: "day" },
			data: {
				values: [
					{ key: "pageviews", count: 5 },
					{ key: "visitors", count: 5 },
				],
			},
			previous: {
				range: { from: day("2026-01-16"), to: day("2026-02-15"), interval: "day" },
				data: {
					shape: "number",
					values: [
						{ key: "pageviews", label: "Page views", count: 1, of: null },
						{ key: "visitors", label: "Visitors", count: 1, of: null },
					],
				},
				problem: null,
				countedFrom: null,
				sites: null,
			},
		});

		// Exploring another range compares with the period before that one.
		expect(await data(widgets.totals, { range: { preset: "last7Days" }, compare: true })).toMatchObject({
			range: { from: day("2026-03-10"), to: day("2026-03-17") },
			data: { values: [{ count: 3 }, { count: 3 }] },
			previous: {
				range: { from: day("2026-03-03"), to: day("2026-03-10"), interval: "day" },
				data: { values: [{ count: 2 }, { count: 2 }] },
			},
		});
	});

	test("a custom range, explored or the Widget's own, works the same way", async () => {
		const custom = { preset: "custom" as const, from: "2026-03-09", to: "2026-03-15" };
		expect(await data(widgets.totals, { range: custom, compare: true })).toMatchObject({
			range: { from: day("2026-03-09"), to: day("2026-03-16") },
			data: { values: [{ count: 2 }, { count: 2 }] },
			previous: {
				range: { from: day("2026-03-02"), to: day("2026-03-09"), interval: "day" },
				data: { values: [{ count: 1 }, { count: 1 }] },
			},
		});
		// The Widget's own range wins over the one explored, and so does the period before it.
		expect(await data(widgets.ownRange, { range: { preset: "today" }, compare: true })).toMatchObject({
			range: { from: day("2026-03-09"), to: day("2026-03-16") },
			data: { values: [{ key: "pageviews", count: 2 }] },
			previous: { range: { from: day("2026-03-02"), to: day("2026-03-09") }, data: { values: [{ count: 1 }] } },
		});
	});

	test("Over time: the lines before, counted by the same hour or day, point for point", async () => {
		const today = await data(widgets.trend, { range: { preset: "today" }, compare: true });
		expect(today.range).toEqual({ from: day("2026-03-16"), to: day("2026-03-17"), interval: "hour" });
		expect(today.previous?.range).toEqual({ from: day("2026-03-15"), to: day("2026-03-16"), interval: "hour" });
		if (today.data?.shape !== "series" || today.previous?.data?.shape !== "series") throw new Error("Not lines.");
		expect(today.previous.data.lines).toEqual([{ key: "pageviews", label: "Page views" }]);
		expect(today.previous.data.points).toHaveLength(today.data.points.length);
		expect(today.previous.data.points[0]?.start).toEqual(day("2026-03-15"));
		expect(today.previous.data.points.find((point) => point.values.pageviews === 1)?.start).toEqual(
			new Date("2026-03-15T12:00:00Z"),
		);
		expect(today.data.points.reduce((sum, point) => sum + (point.values.pageviews ?? 0), 0)).toBe(2);

		const week = await data(widgets.trend, { range: { preset: "last7Days" }, compare: true });
		if (week.data?.shape !== "series" || week.previous?.data?.shape !== "series") throw new Error("Not lines.");
		expect(week.previous.data.points.map((point) => [point.start, point.values.pageviews])).toEqual([
			[day("2026-03-03"), 0],
			[day("2026-03-04"), 0],
			[day("2026-03-05"), 1],
			[day("2026-03-06"), 0],
			[day("2026-03-07"), 0],
			[day("2026-03-08"), 0],
			[day("2026-03-09"), 1],
		]);
	});

	test("a Widget that doesn't compare answers no period before; a request that doesn't ask gets none", async () => {
		expect((await data(widgets.pages, { compare: true })).previous).toBeNull();
		expect((await data(widgets.note, { compare: true })).previous).toBeNull();

		const plain = await data(widgets.totals);
		expect("previous" in plain).toBe(false);
		expect(await data(widgets.totals, { compare: false })).toEqual(plain);

		// The catalog says which kinds compare.
		const { kinds } = await staff.api.dashboards.catalog({ siteId });
		expect(kinds.filter((kind) => kind.compares).map((kind) => kind.kind)).toEqual([
			"site-analytics:totals",
			"site-analytics:trend",
			"site-analytics:goal",
		]);
	});

	test("a Workspace Dashboard compares its Sites added up", async () => {
		const { dashboard } = await staff.api.dashboards.create({ workspaceId, name: "Every Site" });
		const { widgetId } = await staff.api.dashboards.widgets.add({
			workspaceId,
			dashboardId: dashboard.id,
			kind: "site-analytics:totals",
			settings: { measures: ["pageviews"] },
		});
		const { widget } = await staff.api.dashboards.widgets.data({
			workspaceId,
			dashboardId: dashboard.id,
			widgetId,
			range: { preset: "last7Days" },
			compare: true,
		});
		expect(widget).toMatchObject({
			data: { values: [{ count: 3 }] },
			sites: { counted: 1, of: 1 },
			previous: { data: { values: [{ count: 2 }] }, sites: { counted: 1, of: 1 } },
		});
	});
});
