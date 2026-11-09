// Dashboards (#103): Staff build a Site's Dashboards from the fixed Widget catalog (Site analytics'
// Widgets and WebCraft's note), place and size them on a grid, and give each its own range, filters
// and settings. A Widget's data are worked out when someone looks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsApi, analyticsVisitor, liveSite } from "../harness/analytics.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let domains = 0;

beforeAll(async () => {
	// A Monday at 09:00 UTC: "today" and "last 7 days" are easy to read.
	install = await createTestInstall({ now: new Date("2026-03-16T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const newSite = async () => {
	const site = await liveSite(install, staff, workspaceId, `dash-${++domains}.example`);
	await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	return site;
};

const rects = (dashboard: { widgets: { kind: string; x: number; y: number; w: number; h: number }[] }) =>
	dashboard.widgets.map(({ kind, x, y, w, h }) => [kind, x, y, w, h]);

describe("the Widget catalog", () => {
	test("is Site analytics' Widgets and WebCraft's note, each with its filters and settings", async () => {
		const { siteId } = await newSite();
		const { kinds } = await staff.api.dashboards.catalog({ siteId });

		expect(kinds.map((kind) => [kind.kind, kind.shape, kind.available])).toEqual([
			["note", "note", true],
			["site-analytics:totals", "number", true],
			["site-analytics:trend", "series", true],
			["site-analytics:top-pages", "table", true],
			["site-analytics:sources", "table", true],
			["site-analytics:countries", "table", true],
			["site-analytics:devices", "table", true],
			["site-analytics:browsers", "table", true],
			["site-analytics:operating-systems", "table", true],
			["site-analytics:links", "table", true],
			["site-analytics:custom-events", "table", true],
			["site-analytics:goals", "table", true],
			["site-analytics:goal", "number", true],
			["site-analytics:funnel", "funnel", true],
		]);
		const totals = kinds.find((kind) => kind.kind === "site-analytics:totals");
		expect(totals).toMatchObject({
			module: "Site analytics",
			label: "Totals",
			filters: ["page", "source", "country", "device", "goal"],
			settings: [
				{
					key: "measures",
					label: "Show",
					multiple: true,
					default: ["pageviews", "visitors", "visits", "events"],
					options: [
						{ value: "pageviews", label: "Page views" },
						{ value: "visitors", label: "Visitors" },
						{ value: "visits", label: "Visits" },
						{ value: "events", label: "Events" },
					],
				},
			],
		});
		// The Goals a setting offers are the Site's own, asked for when needed.
		expect(kinds.find((kind) => kind.kind === "site-analytics:goal")?.settings[0]?.options).toBeNull();
		await analyticsApi(staff).goals.create({
			siteId,
			name: "Signed up",
			definition: { kind: "event", event: "signup" },
		});
		expect(await staff.api.dashboards.options({ siteId, kind: "site-analytics:goal", setting: "goal" })).toEqual({
			options: [{ value: "Signed up", label: "Signed up" }],
		});
		expect(
			await staff.api.dashboards.options({ siteId, kind: "site-analytics:totals", setting: "filter:goal" }),
		).toEqual({ options: [{ value: "Signed up", label: "Signed up" }] });
	});

	test("says which Widgets can't count where Site analytics is off", async () => {
		const { siteId } = await newSite();
		await staff.api.modules.setOnSite({ siteId, moduleId: "site-analytics", on: false });

		const { kinds } = await staff.api.dashboards.catalog({ siteId });
		expect(kinds.filter((kind) => kind.available).map((kind) => kind.kind)).toEqual(["note"]);
	});
});

describe("a Dashboard's grid", () => {
	test("places new Widgets in the first free place, moves and resizes them, pushing what they cover down", async () => {
		const { siteId } = await newSite();
		const { dashboard } = await staff.api.dashboards.create({ siteId, name: "Overview" });
		expect(dashboard).toMatchObject({ name: "Overview", range: { preset: "last30Days" }, widgets: [] });

		const add = async (kind: string) =>
			(await staff.api.dashboards.widgets.add({ siteId, dashboardId: dashboard.id, kind })).dashboard;
		await add("site-analytics:totals");
		await add("note");
		await add("site-analytics:trend");
		const added = await add("site-analytics:top-pages");
		expect(rects(added)).toEqual([
			["site-analytics:totals", 0, 0, 6, 2],
			["note", 6, 0, 4, 2],
			["site-analytics:trend", 0, 2, 8, 4],
			["site-analytics:top-pages", 0, 6, 6, 5],
		]);

		// The note moves onto the top left: the totals move down below it, and the trend below them.
		const note = added.widgets[1]?.id ?? "";
		const moved = await staff.api.dashboards.widgets.move({
			siteId,
			dashboardId: dashboard.id,
			widgetId: note,
			x: 0,
			y: 0,
			w: 4,
			h: 2,
		});
		expect(rects(moved.dashboard)).toEqual([
			["site-analytics:totals", 0, 2, 6, 2],
			["note", 0, 0, 4, 2],
			["site-analytics:trend", 0, 4, 8, 4],
			["site-analytics:top-pages", 0, 8, 6, 5],
		]);

		// Wider than the grid, it stays on it.
		const resized = await staff.api.dashboards.widgets.move({
			siteId,
			dashboardId: dashboard.id,
			widgetId: note,
			x: 10,
			y: 0,
			w: 12,
			h: 3,
		});
		expect(rects(resized.dashboard)[1]).toEqual(["note", 0, 0, 12, 3]);

		const removed = await staff.api.dashboards.widgets.remove({ siteId, dashboardId: dashboard.id, widgetId: note });
		expect(removed.dashboard.widgets.map((widget) => widget.kind)).not.toContain("note");
		expect((await staff.api.dashboards.list({ siteId })).dashboards).toEqual([
			expect.objectContaining({ name: "Overview", widgets: 3, sharedWithEveryone: false }),
		]);
	});

	test("refuses a kind, a filter or a setting the catalog doesn't have", async () => {
		const { siteId } = await newSite();
		const { dashboard } = await staff.api.dashboards.create({ siteId, name: "Checks" });
		const dashboardId = dashboard.id;
		const refused = (problem: string) => expect.objectContaining({ code: "DASHBOARD_INVALID", data: { problem } });

		await expect(
			staff.api.dashboards.widgets.add({ siteId, dashboardId, kind: "site-analytics:nope" }),
		).rejects.toEqual(refused("kind"));
		await expect(
			staff.api.dashboards.widgets.add({
				siteId,
				dashboardId,
				kind: "site-analytics:funnel",
				filters: { page: { path: "/", match: "exact" } },
			}),
		).rejects.toEqual(refused("filter"));
		await expect(
			staff.api.dashboards.widgets.add({
				siteId,
				dashboardId,
				kind: "site-analytics:totals",
				settings: { measures: ["bounces"] },
			}),
		).rejects.toEqual(refused("setting"));
		await expect(
			staff.api.dashboards.widgets.add({
				siteId,
				dashboardId,
				kind: "site-analytics:totals",
				range: { preset: "custom", from: "2026-03-10", to: "2026-03-01" },
			}),
		).rejects.toEqual(refused("range"));
		await expect(
			staff.api.dashboards.widgets.add({ siteId, dashboardId, kind: "note", settings: { text: "x".repeat(2001) } }),
		).rejects.toMatchObject({ status: 400 });
	});
});

describe("a Widget's data", () => {
	test("counts its own range, or the Dashboard's, narrowed by its filters", async () => {
		const site = await newSite();
		const { siteId } = site;
		await analyticsApi(staff).goals.create({
			siteId,
			name: "Signed up",
			definition: { kind: "event", event: "signup" },
		});
		const reader = analyticsVisitor(install, site.origin, { address: "203.0.113.71" });
		await reader.view("/", { r: "search.example" });
		await reader.send({ t: "event", p: "/", n: "signup" });
		await install.clock.advance(60_000);
		await analyticsVisitor(install, site.origin, { address: "198.51.100.72" }).view("/menu");
		// Last week's visit counts in the last 30 days, not today.
		await install.clock.set(new Date("2026-03-09T12:00:00Z"));
		await analyticsVisitor(install, site.origin, { address: "203.0.113.73" }).view("/");
		await install.clock.set(new Date("2026-03-16T10:00:00Z"));

		const { dashboard } = await staff.api.dashboards.create({ siteId, name: "Sales" });
		const dashboardId = dashboard.id;
		const add = async (input: Omit<Parameters<typeof staff.api.dashboards.widgets.add>[0], "siteId" | "dashboardId">) =>
			(await staff.api.dashboards.widgets.add({ siteId, dashboardId, ...input })).widgetId;
		const month = await add({ kind: "site-analytics:totals", settings: { measures: ["pageviews", "visitors"] } });
		const today = await add({ kind: "site-analytics:totals", title: "Today", range: { preset: "today" } });
		const fromSearch = await add({ kind: "site-analytics:totals", filters: { source: "search.example" } });
		const converted = await add({ kind: "site-analytics:goal", settings: { goal: "Signed up" } });
		const pages = await add({ kind: "site-analytics:top-pages", rows: 5 });
		const note = await add({ kind: "note", settings: { text: "Spring sale started on 9 March." } });
		const data = async (widgetId: string, range?: { preset: "today" | "last7Days" }) =>
			(await staff.api.dashboards.widgets.data({ siteId, dashboardId, widgetId, range })).widget;

		expect(await data(month)).toMatchObject({
			title: "Totals",
			range: { from: new Date("2026-02-15T00:00:00Z"), to: new Date("2026-03-17T00:00:00Z"), interval: "day" },
			data: {
				shape: "number",
				values: [
					{ key: "pageviews", label: "Page views", count: 3, of: null },
					{ key: "visitors", label: "Visitors", count: 3, of: null },
				],
			},
			problem: null,
			sites: null,
		});
		expect(await data(today)).toMatchObject({
			title: "Today",
			range: { from: new Date("2026-03-16T00:00:00Z"), to: new Date("2026-03-17T00:00:00Z"), interval: "hour" },
			data: {
				values: [
					{ key: "pageviews", count: 2 },
					{ key: "visitors", count: 2 },
					{ key: "visits", count: 2 },
					{ key: "events", count: 1 },
				],
			},
		});
		// Exploring another range changes the Widgets that show the Dashboard's, not those with their own.
		expect((await data(month, { preset: "today" })).data).toMatchObject({ values: [{ count: 2 }, { count: 2 }] });
		expect((await data(fromSearch)).data).toMatchObject({
			values: [
				{ key: "pageviews", count: 1 },
				{ key: "visitors", count: 1 },
				{ key: "visits", count: 1 },
				{ key: "events", count: 1 },
			],
		});
		expect((await data(converted)).data).toEqual({
			shape: "number",
			values: [
				{ key: "conversions", label: "Conversions", count: 1, of: null },
				{ key: "visitors", label: "Visitors converted", count: 1, of: null },
				{ key: "rate", label: "Conversion rate", count: 1, of: 3 },
			],
		});
		expect((await data(pages)).data).toEqual({
			shape: "table",
			columns: [
				{ key: "value", label: "Page", kind: "path" },
				{ key: "pageviews", label: "Page views", kind: "count" },
				{ key: "visitors", label: "Visitors", kind: "count" },
			],
			rows: [
				{ key: "/", cells: { value: "/", pageviews: 2, visitors: 2 } },
				{ key: "/menu", cells: { value: "/menu", pageviews: 1, visitors: 1 } },
			],
		});
		expect((await data(note)).data).toEqual({ shape: "note", text: "Spring sale started on 9 March." });
	});

	test("says why it shows nothing: a Goal the Site lacks, or Site analytics switched off", async () => {
		const { siteId } = await newSite();
		const { dashboard } = await staff.api.dashboards.create({ siteId, name: "Problems" });
		const { widgetId } = await staff.api.dashboards.widgets.add({
			siteId,
			dashboardId: dashboard.id,
			kind: "site-analytics:goal",
			settings: { goal: "Booked a table" },
		});
		const data = async () =>
			(await staff.api.dashboards.widgets.data({ siteId, dashboardId: dashboard.id, widgetId })).widget;

		expect(await data()).toMatchObject({ data: null, problem: { code: "GOAL_NOT_FOUND" } });
		await analyticsApi(staff).goals.create({
			siteId,
			name: "booked a TABLE",
			definition: { kind: "event", event: "book" },
		});
		expect(await data()).toMatchObject({ problem: null, data: { shape: "number" } });

		await staff.api.modules.setOnSite({ siteId, moduleId: "site-analytics", on: false });
		expect(await data()).toMatchObject({ data: null, problem: { code: "MODULE_NOT_RUNNING" } });
	});

	test("of a Funnel and of every Goal", async () => {
		const site = await newSite();
		const { siteId } = site;
		const { goal } = await analyticsApi(staff).goals.create({
			siteId,
			name: "Signed up",
			definition: { kind: "event", event: "signup" },
		});
		await analyticsApi(staff).goals.create({ siteId, name: "Menu", definition: { kind: "page", path: "/menu" } });
		await analyticsApi(staff).funnels.create({
			siteId,
			name: "Sign-up",
			steps: [
				{ kind: "page", path: "/", match: "exact" },
				{ kind: "goal", goalId: goal.id },
			],
		});
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.74" });
		await visitor.view("/");
		await install.clock.advance(60_000);
		await visitor.send({ t: "event", p: "/", n: "signup" });
		await analyticsVisitor(install, site.origin, { address: "203.0.113.75" }).view("/");

		const { dashboard } = await staff.api.dashboards.create({ siteId, name: "Conversions" });
		const add = async (kind: string, settings: Record<string, string>) =>
			(await staff.api.dashboards.widgets.add({ siteId, dashboardId: dashboard.id, kind, settings })).widgetId;
		const funnel = await add("site-analytics:funnel", { funnel: "Sign-up" });
		const goals = await add("site-analytics:goals", {});
		const data = async (widgetId: string) =>
			(await staff.api.dashboards.widgets.data({ siteId, dashboardId: dashboard.id, widgetId })).widget.data;

		expect(await data(funnel)).toEqual({
			shape: "funnel",
			steps: [
				{ label: "/", count: 2 },
				{ label: "Signed up", count: 1 },
			],
		});
		expect(await data(goals)).toMatchObject({
			shape: "table",
			rows: [
				{ cells: { goal: "Menu", conversions: 0, visitors: 0, rate: { count: 0, of: 2 } } },
				{ cells: { goal: "Signed up", conversions: 1, visitors: 1, rate: { count: 1, of: 2 } } },
			],
		});
	});
});
