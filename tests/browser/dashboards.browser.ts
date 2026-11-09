// Dashboards in a real browser (#103): a Dashboard with every shape of Widget (numbers, a chart over
// time and its table, tables, a Funnel and a note), the Widget picker, a Widget's menu and editor,
// moving and resizing a Widget from the keyboard (checked by what is saved, and said in the live
// region), a Workspace Dashboard, and Site analytics' Goal and Funnel editors, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type siteAnalytics from "@webcraft/module-site-analytics";

import { analyticsVisitor } from "../harness/analytics.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let staffBrowser: TestBrowser;
let workspaceId: string;
let siteId: string;
let dashboardId: string;
let workspaceDashboardId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	// The web process counts by the real clock: the visits come now too.
	await local.clock.set(new Date());
	const admin = await local.superadmin();
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await install.goLive(siteId);
	await admin.api.modules.setOnSite({ siteId, moduleId: "site-analytics", on: true });
	await admin.api.consentBanner.setSettings({ siteId, mode: "none", layout: "bar" });
	const member = await local.createStaff({ workspaces: [workspaceId] });
	staff = member.account;
	staffBrowser = member.browser;

	const analytics = moduleApi<typeof siteAnalytics>(staffBrowser, "site-analytics");
	const { goal } = await analytics.goals.create({
		siteId,
		name: "Signed up",
		definition: { kind: "event", event: "signup" },
	});
	await analytics.goals.create({ siteId, name: "Saw the menu", definition: { kind: "page", path: "/menu" } });
	await analytics.funnels.create({
		siteId,
		name: "Sign-up",
		steps: [
			{ kind: "page", path: "/", match: "exact" },
			{ kind: "goal", goalId: goal.id },
		],
	});
	const origin = new URL(install.liveUrl("bakery", "/")).origin;
	const visitors = [
		{ address: "203.0.113.20", path: "/", from: "search.example" },
		{ address: "198.51.100.21", path: "/menu", from: "" },
		{ address: "192.0.2.22", path: "/", from: "news.example" },
	];
	for (const { address, path, from } of visitors) {
		const visitor = analyticsVisitor(local, origin, { address });
		await visitor.view(path, { r: from });
		await local.clock.advance(30_000);
		if (path === "/") await visitor.send({ t: "event", p: "/", n: "signup" });
	}

	const { dashboard } = await staffBrowser.api.dashboards.create({ siteId, name: "Overview" });
	dashboardId = dashboard.id;
	const add = (kind: string, settings: Record<string, string | string[]> = {}) =>
		staffBrowser.api.dashboards.widgets.add({ siteId, dashboardId, kind, settings });
	await add("site-analytics:totals");
	await add("note", { text: "Spring sale started on Monday." });
	await add("site-analytics:trend");
	await add("site-analytics:top-pages");
	await add("site-analytics:sources");
	await add("site-analytics:funnel", { funnel: "Sign-up" });
	await add("site-analytics:goals");
	const made = await staffBrowser.api.dashboards.create({ workspaceId, name: "All Sites" });
	workspaceDashboardId = made.dashboard.id;
	await staffBrowser.api.dashboards.widgets.add({
		workspaceId,
		dashboardId: workspaceDashboardId,
		kind: "site-analytics:totals",
	});
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Dashboards, ${theme}`, () => {
		const open = async (path: string) => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(path));
			await page.waitForLoadState("networkidle");
			return page;
		};
		const openOverview = async () => {
			const page = await open(`/sites/${siteId}/dashboards/${dashboardId}`);
			await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
			// Every Widget has counted.
			await page.getByText("Counting…").first().waitFor({ state: "detached" });
			return page;
		};

		test("a Dashboard with every shape of Widget", async () => {
			const page = await openOverview();
			await page.getByText("Spring sale started on Monday.").waitFor();
			await page.getByRole("img", { name: /Over time/ }).waitFor();
			await page.getByText("Step 2 · Signed up").waitFor();
			expect(await page.title()).toContain("Overview");

			await expectAccessibleScreen(page, `Dashboard (${theme})`);
		});

		test("a chart shown as a table", async () => {
			const page = await openOverview();
			await page.getByRole("button", { name: "Show as a table" }).first().click();
			await page.getByRole("columnheader", { name: "Start (UTC)" }).waitFor();
			await expectNoAxeViolations(page, `Dashboard › a chart as a table (${theme})`);
		});

		test("the Widget picker, from the keyboard", async () => {
			const page = await openOverview();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add Widget" }),
				"dialog",
				`Dashboard › Add a Widget (${theme})`,
			);
		});

		test("a Widget's menu, and its editor", async () => {
			const page = await openOverview();
			const menu = page.getByRole("button", { name: "Actions for Totals" });
			await expectOverlayUsable(page, menu, "menu", `Dashboard › a Widget's menu (${theme})`);

			await menu.focus();
			await page.keyboard.press("Enter");
			await page.getByRole("menuitem", { name: "Edit Widget" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("Visitors who reached").waitFor();
			await dialog.getByRole("option", { name: "Signed up" }).waitFor({ state: "attached" });
			await expectNoAxeViolations(page, `Dashboard › a Widget's editor (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
		});

		test("moving and resizing a Widget from the keyboard", async () => {
			const { dashboard } = await staffBrowser.api.dashboards.create({ siteId, name: `Moves ${theme}` });
			const { widgetId } = await staffBrowser.api.dashboards.widgets.add({
				siteId,
				dashboardId: dashboard.id,
				kind: "note",
				title: "Plan",
				settings: { text: "Campaign notes" },
			});
			const page = await open(`/sites/${siteId}/dashboards/${dashboard.id}`);
			const saved = async () =>
				(await staffBrowser.api.dashboards.get({ siteId, dashboardId: dashboard.id })).dashboard.widgets.find(
					(widget) => widget.id === widgetId,
				);
			/** The saved place and size, once a save on its way has landed (or as it stays). */
			const savedAs = async (expected: Record<string, number>) => {
				const deadline = Date.now() + 5000;
				let found = await saved();
				while (
					Date.now() < deadline &&
					!Object.entries(expected).every(([key, value]) => found?.[key as "x"] === value)
				) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					found = await saved();
				}
				return found;
			};
			const status = page.getByRole("status").filter({ hasText: "Plan:" });
			const handle = page.getByRole("button", { name: "Move or resize Plan" });

			await handle.focus();
			await page.keyboard.press("Alt+ArrowRight");
			await status.filter({ hasText: "column 2, row 1, 4 wide, 2 tall" }).waitFor({ state: "attached" });
			expect(await savedAs({ x: 1, y: 0, w: 4, h: 2 })).toMatchObject({ x: 1, y: 0, w: 4, h: 2 });

			await page.keyboard.press("Alt+Shift+ArrowRight");
			await page.keyboard.press("Alt+Shift+ArrowDown");
			await status.filter({ hasText: "column 2, row 1, 5 wide, 3 tall" }).waitFor({ state: "attached" });
			expect(await savedAs({ x: 1, y: 0, w: 5, h: 3 })).toMatchObject({ x: 1, y: 0, w: 5, h: 3 });

			// Picked up, the arrows move it; Escape puts it back where it was, saving nothing.
			await page.keyboard.press("Space");
			await page.getByRole("status").filter({ hasText: "Plan picked up" }).waitFor({ state: "attached" });
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("Escape");
			await page.getByRole("status").filter({ hasText: "Plan put back" }).waitFor({ state: "attached" });
			expect(await saved()).toMatchObject({ x: 1, y: 0 });

			// Space puts it down where the arrows took it.
			await page.keyboard.press("Space");
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("ArrowLeft");
			await page.keyboard.press("Space");
			await status.filter({ hasText: "column 1, row 2, 5 wide, 3 tall" }).waitFor({ state: "attached" });
			expect(await savedAs({ x: 0, y: 1, w: 5, h: 3 })).toMatchObject({ x: 0, y: 1, w: 5, h: 3 });
		});

		test("a Workspace Dashboard adding up its Sites", async () => {
			const page = await open(`/workspaces/${workspaceId}/dashboards/${workspaceDashboardId}`);
			await page.getByRole("heading", { name: "All Sites", level: 1 }).waitFor();
			await page.getByText("Counted on 1 of 1 Sites, visitors added up Site by Site and day by day.").waitFor();
			await expectAccessibleScreen(page, `Workspace Dashboard (${theme})`);
		});

		test("Site › Goals and its Goal editor", async () => {
			const page = await open(`/sites/${siteId}/m/site-analytics/goals`);
			await page.getByRole("cell", { name: "Saw the menu", exact: true }).waitFor();
			await expectAccessibleScreen(page, `Goals (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add Goal" }),
				"dialog",
				`Goals › Add a Goal (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Signed up" }),
				"menu",
				`Goals › a Goal's menu (${theme})`,
			);
		});

		test("Site › Funnels and its Funnel editor, steps moved from the keyboard", async () => {
			const page = await open(`/sites/${siteId}/m/site-analytics/funnels`);
			await page.getByRole("cell", { name: "Sign-up", exact: true }).waitFor();
			await expectAccessibleScreen(page, `Funnels (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add Funnel" }),
				"dialog",
				`Funnels › Add a Funnel (${theme})`,
			);

			await page.getByRole("button", { name: "Add Funnel" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("button", { name: "Move step 1 down" }).focus();
			await page.keyboard.press("Enter");
			await dialog.getByRole("status").filter({ hasText: "Step moved: now 2 of 2." }).waitFor({ state: "attached" });
			await expectNoAxeViolations(page, `Funnels › a step moved (${theme})`, ["region"]);
		});
	});
}
