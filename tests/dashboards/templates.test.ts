// Dashboard templates and Workspace Dashboards (#103). A template keeps a Dashboard's Widgets and
// range, to start Dashboards from on other Sites, even of other Workspaces, with its Goals and Funnels
// mapped by name. A Workspace Dashboard adds up its Sites (visitors Site by Site and day by day).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsApi, analyticsVisitor, liveSite } from "../harness/analytics.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-16T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
});

afterAll(async () => {
	await install.close();
});

async function analyticsSite(browser: TestBrowser, workspaceId: string) {
	const site = await liveSite(install, browser, workspaceId, `templates-${++domains}.example`);
	await browser.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	return site;
}

describe("Dashboard templates", () => {
	test("start Dashboards on another Workspace's Site, its Goals found by name", async () => {
		const agency = await install.createWorkspace("Bakery client");
		const other = await install.createWorkspace("Florist client");
		const staff = (await install.createStaff({ workspaces: [agency.id, other.id] })).browser;
		const onlyOther = (await install.createStaff({ workspaces: [other.id] })).browser;

		const bakery = await analyticsSite(staff, agency.id);
		await analyticsApi(staff).goals.create({
			siteId: bakery.siteId,
			name: "Signed up",
			definition: { kind: "event", event: "signup" },
		});
		const { dashboard } = await staff.api.dashboards.create({ siteId: bakery.siteId, name: "Standard" });
		await staff.api.dashboards.update({
			siteId: bakery.siteId,
			dashboardId: dashboard.id,
			range: { preset: "last7Days" },
		});
		const add = (input: Omit<Parameters<typeof staff.api.dashboards.widgets.add>[0], "siteId" | "dashboardId">) =>
			staff.api.dashboards.widgets.add({ siteId: bakery.siteId, dashboardId: dashboard.id, ...input });
		await add({ kind: "site-analytics:totals", filters: { goal: "Signed up" } });
		await add({ kind: "site-analytics:goal", settings: { goal: "Signed up" } });
		await add({ kind: "site-analytics:funnel", settings: { funnel: "Sign-up" } });
		const { template } = await staff.api.dashboards.saveAsTemplate({
			siteId: bakery.siteId,
			dashboardId: dashboard.id,
			name: "Client standard",
		});
		expect(template).toMatchObject({
			workspaceId: agency.id,
			workspace: "Bakery client",
			name: "Client standard",
			madeFrom: "Standard",
			widgets: 3,
		});
		expect((await staff.api.dashboardTemplates.list()).templates.map((each) => each.name)).toEqual(["Client standard"]);
		// Staff of the other Workspace only never see the bakery's templates.
		expect((await onlyOther.api.dashboardTemplates.list()).templates).toEqual([]);

		const florist = await analyticsSite(staff, other.id);
		await analyticsApi(staff).goals.create({
			siteId: florist.siteId,
			name: "signed UP",
			definition: { kind: "event", event: "register" },
		});
		const made = await staff.api.dashboards.create({
			siteId: florist.siteId,
			name: "Standard",
			template: { workspaceId: agency.id, templateId: template.id },
		});
		expect(made.dashboard.range).toEqual({ preset: "last7Days" });
		expect(made.dashboard.widgets.map((widget) => [widget.kind, widget.x, widget.y])).toEqual([
			["site-analytics:totals", 0, 0],
			["site-analytics:goal", 6, 0],
			["site-analytics:funnel", 0, 2],
		]);
		// The florist's Site has its own "signed up" Goal, but no Funnel named Sign-up yet.
		expect(made.unmatched).toEqual(["Sign-up"]);

		await analyticsVisitor(install, florist.origin, { address: "203.0.113.91" }).send({
			t: "event",
			p: "/",
			n: "register",
		});
		const goalWidget = made.dashboard.widgets[1]?.id ?? "";
		const counted = await staff.api.dashboards.widgets.data({
			siteId: florist.siteId,
			dashboardId: made.dashboard.id,
			widgetId: goalWidget,
		});
		expect(counted.widget.data).toMatchObject({
			values: [
				{ key: "conversions", count: 1 },
				{ key: "visitors", count: 1 },
				{ key: "rate", count: 1, of: 1 },
			],
		});

		await expect(
			onlyOther.api.dashboards.create({
				siteId: florist.siteId,
				name: "Copied",
				template: { workspaceId: agency.id, templateId: template.id },
			}),
		).rejects.toMatchObject({ code: "DASHBOARD_TEMPLATE_NOT_FOUND" });

		await staff.api.dashboardTemplates.delete({ workspaceId: agency.id, templateId: template.id });
		expect((await staff.api.dashboardTemplates.list()).templates).toEqual([]);
	});
});

describe("a Workspace Dashboard", () => {
	test("adds up the Workspace's Sites the person sees, visitors Site by Site", async () => {
		const workspace = await install.createWorkspace("Chain of shops");
		const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		const north = await analyticsSite(staff, workspace.id);
		const south = await analyticsSite(staff, workspace.id);
		const off = await install.createSite(workspace.id, { name: "Archive" });
		await analyticsApi(staff).goals.create({
			siteId: north.siteId,
			name: "Booked",
			definition: { kind: "event", event: "book" },
		});
		await analyticsApi(staff).goals.create({
			siteId: south.siteId,
			name: "booked",
			definition: { kind: "event", event: "reserve" },
		});
		const one = analyticsVisitor(install, north.origin, { address: "203.0.113.92" });
		await one.view("/");
		await one.send({ t: "event", p: "/", n: "book" });
		await analyticsVisitor(install, north.origin, { address: "203.0.113.93" }).view("/");
		const two = analyticsVisitor(install, south.origin, { address: "203.0.113.92" });
		await two.view("/");
		await two.view("/menu", { i: 1 });
		await two.send({ t: "event", p: "/menu", n: "reserve" });

		const place = { workspaceId: workspace.id };
		const { dashboard } = await staff.api.dashboards.create({ ...place, name: "All shops" });
		const add = async (kind: string, settings: Record<string, string> = {}) =>
			(await staff.api.dashboards.widgets.add({ ...place, dashboardId: dashboard.id, kind, settings })).widgetId;
		const totals = await add("site-analytics:totals");
		const pages = await add("site-analytics:top-pages");
		const booked = await add("site-analytics:goal", { goal: "Booked" });
		const data = async (browser: TestBrowser, widgetId: string) =>
			(await browser.api.dashboards.widgets.data({ ...place, dashboardId: dashboard.id, widgetId })).widget;

		expect(await data(staff, totals)).toMatchObject({
			sites: { counted: 2, of: 3 },
			data: {
				values: [
					{ key: "pageviews", count: 4 },
					// The same person on both Sites counts on each.
					{ key: "visitors", count: 3 },
					{ key: "visits", count: 3 },
					{ key: "events", count: 2 },
				],
			},
		});
		expect((await data(staff, pages)).data).toMatchObject({
			rows: [
				{ key: "/", cells: { value: "/", pageviews: 3, visitors: 3 } },
				{ key: "/menu", cells: { value: "/menu", pageviews: 1, visitors: 1 } },
			],
		});
		expect((await data(staff, booked)).data).toMatchObject({
			values: [
				{ key: "conversions", count: 2 },
				{ key: "visitors", count: 2 },
				{ key: "rate", count: 2, of: 3 },
			],
		});
		expect(
			(await staff.api.dashboards.options({ ...place, kind: "site-analytics:goal", setting: "goal" })).options,
		).toEqual([
			{ value: "Booked", label: "Booked" },
			{ value: "booked", label: "booked" },
		]);

		// An Owner reaching one Site sees that Site's numbers only.
		const owner = (await install.createMember({ workspaceId: workspace.id, role: "owner", sites: [north.siteId] }))
			.browser;
		expect(await data(owner, totals)).toMatchObject({
			sites: { counted: 1, of: 1 },
			data: {
				values: [
					{ key: "pageviews", count: 2 },
					{ key: "visitors", count: 2 },
					{ key: "visits", count: 2 },
					{ key: "events", count: 1 },
				],
			},
		});
		// Editors see it once Staff show it to everyone.
		const editor = (await install.createMember({ workspaceId: workspace.id, role: "editor" })).browser;
		expect((await editor.api.dashboards.list(place)).dashboards).toEqual([]);
		await staff.api.dashboards.update({ ...place, dashboardId: dashboard.id, sharedWithEveryone: true });
		expect((await data(editor, totals)).sites).toEqual({ counted: 2, of: 3 });
		expect(off.id).toBeTruthy();
	});

	test("doesn't add up a Funnel whose Sites built different steps, and says so", async () => {
		const workspace = await install.createWorkspace("Mixed funnels");
		const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		const north = await analyticsSite(staff, workspace.id);
		const south = await analyticsSite(staff, workspace.id);

		const { goal: signedUp } = await analyticsApi(staff).goals.create({
			siteId: north.siteId,
			name: "Signed up",
			definition: { kind: "event", event: "signup" },
		});
		await analyticsApi(staff).funnels.create({
			siteId: north.siteId,
			name: "Launch",
			steps: [
				{ kind: "page", path: "/", match: "exact" },
				{ kind: "goal", goalId: signedUp.id },
			],
		});
		const { goal: bought } = await analyticsApi(staff).goals.create({
			siteId: south.siteId,
			name: "Bought",
			definition: { kind: "event", event: "buy" },
		});
		await analyticsApi(staff).funnels.create({
			siteId: south.siteId,
			name: "Launch",
			steps: [
				{ kind: "page", path: "/", match: "exact" },
				{ kind: "page", path: "/pricing", match: "exact" },
				{ kind: "goal", goalId: bought.id },
			],
		});

		const northVisitor = analyticsVisitor(install, north.origin, { address: "203.0.113.111" });
		await northVisitor.view("/");
		await install.clock.advance(60_000);
		await northVisitor.send({ t: "event", p: "/", n: "signup" });

		const southVisitor = analyticsVisitor(install, south.origin, { address: "203.0.113.112" });
		await southVisitor.view("/");
		await install.clock.advance(60_000);
		await southVisitor.view("/pricing", { i: 1 });
		await install.clock.advance(60_000);
		await southVisitor.send({ t: "event", p: "/pricing", n: "buy" });

		const place = { workspaceId: workspace.id };
		const { dashboard } = await staff.api.dashboards.create({ ...place, name: "Launch funnel" });
		const { widgetId } = await staff.api.dashboards.widgets.add({
			...place,
			dashboardId: dashboard.id,
			kind: "site-analytics:funnel",
			settings: { funnel: "Launch" },
		});
		const data = async () =>
			(await staff.api.dashboards.widgets.data({ ...place, dashboardId: dashboard.id, widgetId })).widget;

		expect(await data()).toMatchObject({
			sites: { counted: 2, of: 2 },
			data: null,
			problem: { code: "FUNNEL_STEPS_DIFFER" },
		});
	});

	test("adds up a Funnel step by step when every Site built the same steps", async () => {
		const workspace = await install.createWorkspace("Matching funnels");
		const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		const north = await analyticsSite(staff, workspace.id);
		const south = await analyticsSite(staff, workspace.id);

		const makeFunnel = async (siteId: string) => {
			const { goal } = await analyticsApi(staff).goals.create({
				siteId,
				name: "Signed up",
				definition: { kind: "event", event: "signup" },
			});
			await analyticsApi(staff).funnels.create({
				siteId,
				name: "Launch",
				steps: [
					{ kind: "page", path: "/", match: "exact" },
					{ kind: "goal", goalId: goal.id },
				],
			});
		};
		await makeFunnel(north.siteId);
		await makeFunnel(south.siteId);

		const northOne = analyticsVisitor(install, north.origin, { address: "203.0.113.113" });
		await northOne.view("/");
		await install.clock.advance(60_000);
		await northOne.send({ t: "event", p: "/", n: "signup" });
		await analyticsVisitor(install, north.origin, { address: "203.0.113.114" }).view("/");

		const southOne = analyticsVisitor(install, south.origin, { address: "203.0.113.113" });
		await southOne.view("/");
		await install.clock.advance(60_000);
		await southOne.send({ t: "event", p: "/", n: "signup" });

		const place = { workspaceId: workspace.id };
		const { dashboard } = await staff.api.dashboards.create({ ...place, name: "Launch funnel" });
		const { widgetId } = await staff.api.dashboards.widgets.add({
			...place,
			dashboardId: dashboard.id,
			kind: "site-analytics:funnel",
			settings: { funnel: "Launch" },
		});
		const data = async () =>
			(await staff.api.dashboards.widgets.data({ ...place, dashboardId: dashboard.id, widgetId })).widget;

		expect(await data()).toMatchObject({
			sites: { counted: 2, of: 2 },
			problem: null,
			data: {
				shape: "funnel",
				steps: [
					{ label: "/", count: 3 },
					{ label: "Signed up", count: 2 },
				],
			},
		});
	});

	test("are Workspace Dashboards only: a Site's Dashboard isn't reachable as its Workspace's", async () => {
		const workspace = await install.createWorkspace("Separate");
		const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		const site = await install.createSite(workspace.id);
		const { dashboard } = await staff.api.dashboards.create({ siteId: site.id, name: "Site board" });

		expect((await staff.api.dashboards.list({ workspaceId: workspace.id })).dashboards).toEqual([]);
		await expect(
			staff.api.dashboards.get({ workspaceId: workspace.id, dashboardId: dashboard.id }),
		).rejects.toMatchObject({ code: "DASHBOARD_NOT_FOUND" });
		await expect(
			staff.api.dashboards.get({ workspaceId: workspace.id, siteId: site.id, dashboardId: dashboard.id }),
		).rejects.toMatchObject({ status: 400 });
	});
});
