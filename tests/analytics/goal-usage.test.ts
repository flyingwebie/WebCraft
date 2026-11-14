// Where each Goal is used (the Goals screen's "Where it is used"): the Widgets that name it on the
// Site's Dashboards and its Workspace's Dashboards, in its Workspace's Dashboard templates, by name as
// Widgets name Goals, and the Funnels with it as a step. Staff only, as Goals are.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { analyticsApi, liveSite } from "../harness/analytics.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-16T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.2.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

test("names the Widgets, templates, Workspace Dashboards and Funnels that use each Goal", async () => {
	const { siteId } = await liveSite(install, staff, workspaceId, "usage.example");
	const analytics = analyticsApi(staff);
	const goal = async (name: string) =>
		(await analytics.goals.create({ siteId, name, definition: { kind: "event", event: name.toLowerCase() } })).goal;
	const cake = await goal("Order a cake");
	const newsletter = await goal("Newsletter");
	const unused = await goal("Menu download");
	await analytics.funnels.create({
		siteId,
		name: "Cake orders",
		steps: [
			{ kind: "page", path: "/cakes", match: "exact" },
			{ kind: "goal", goalId: cake.id },
		],
	});

	const { dashboard } = await staff.api.dashboards.create({ siteId, name: "Sales" });
	const add = async (input: {
		kind: string;
		title?: string;
		filters?: { goal?: string };
		settings?: Record<string, string | string[]>;
	}) => (await staff.api.dashboards.widgets.add({ siteId, dashboardId: dashboard.id, ...input })).widgetId;
	const oneGoal = await add({ kind: "site-analytics:goal", settings: { goal: "Order a cake" } });
	// Widgets name Goals whatever their case, as templates carry them across Sites.
	const filtered = await add({ kind: "site-analytics:trend", title: "Cake buyers", filters: { goal: "order a CAKE" } });
	const chosen = await add({ kind: "site-analytics:goals", settings: { goals: ["Newsletter"] } });
	// A Goals Widget that chose none shows every Goal and names none.
	await add({ kind: "site-analytics:goals" });
	const { template } = await staff.api.dashboards.saveAsTemplate({ siteId, dashboardId: dashboard.id, name: "Shop" });
	const workspaceDashboard = (await staff.api.dashboards.create({ workspaceId, name: "Every shop" })).dashboard;
	const everywhere = (
		await staff.api.dashboards.widgets.add({
			workspaceId,
			dashboardId: workspaceDashboard.id,
			kind: "site-analytics:goal",
			settings: { goal: "Newsletter" },
		})
	).widgetId;

	const { goals } = await analytics.goals.usage({ siteId });

	const onSales = { kind: "dashboard", id: dashboard.id, name: "Sales" } as const;
	const inShop = { kind: "template", id: template.id, name: "Shop" } as const;
	const usageOf = (goalId: string) => goals.find((each) => each.goalId === goalId);
	expect(usageOf(cake.id)).toEqual({
		goalId: cake.id,
		widgets: [
			{ widgetId: oneGoal, title: null, kind: "goal", on: onSales },
			{ widgetId: filtered, title: "Cake buyers", kind: "trend", on: onSales },
		],
		templates: [
			{ widgetId: expect.any(String), title: null, kind: "goal", on: inShop },
			{ widgetId: expect.any(String), title: "Cake buyers", kind: "trend", on: inShop },
		],
		funnels: [{ id: expect.any(String), name: "Cake orders" }],
	});
	expect(usageOf(newsletter.id)).toMatchObject({
		widgets: [
			{ widgetId: chosen, kind: "goals", on: onSales },
			{
				widgetId: everywhere,
				kind: "goal",
				on: { kind: "workspaceDashboard", id: workspaceDashboard.id, name: "Every shop" },
			},
		],
		templates: [{ kind: "goals", on: inShop }],
		funnels: [],
	});
	expect(usageOf(unused.id)).toEqual({ goalId: unused.id, widgets: [], templates: [], funnels: [] });
});

test("only Staff ask: Owners are refused", async () => {
	const { siteId } = await liveSite(install, staff, workspaceId, "usage-owner.example");
	const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	await expect(analyticsApi(owner).goals.usage({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
