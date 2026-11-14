// Dashboards in a real browser (#103, UI-12): a Dashboard with every shape of Widget (numbers, a
// chart over time and its table, lists, a Funnel and a note), the chart's readout from the keyboard,
// Compare, a Widget's menu, arranging (the Widget library, adding and Undo, a Widget's settings in the
// library's place, removing with Undo), moving and resizing a Widget from the keyboard (checked by
// what is saved, and said in the live region), New Dashboard over the current one, the built-in
// Dashboard's menu, who sees Arrange, a Dashboard on a phone, a Workspace Dashboard, and Site
// analytics' Goal and Funnel editors, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type siteAnalytics from "@webcraft/module-site-analytics";

import { analyticsVisitor } from "../harness/analytics.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let staffBrowser: TestBrowser;
let owner: TestAccount;
let workspaceId: string;
let siteId: string;
let dashboardId: string;
let builtInId: string;
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
	owner = (await local.createMember({ workspaceId, role: "owner" })).account;

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

	builtInId = (await staffBrowser.api.dashboards.list({ siteId })).dashboards.find((each) => each.builtIn)?.id ?? "";
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
	await add("site-analytics:devices");
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

/** A Dashboard of its own for a test that changes one, with a note on it. */
async function scratchDashboard(name: string) {
	const { dashboard } = await staffBrowser.api.dashboards.create({ siteId, name });
	const { widgetId } = await staffBrowser.api.dashboards.widgets.add({
		siteId,
		dashboardId: dashboard.id,
		kind: "note",
		title: "Plan",
		settings: { text: "Campaign notes" },
	});
	return { dashboardId: dashboard.id, widgetId };
}

/** A Dashboard's Widgets as saved, once what is on its way has landed (or as they stay). */
async function savedWidgets(id: string, until: (widgets: { title: string | null; kind: string }[]) => boolean) {
	const deadline = Date.now() + 5000;
	let widgets = (await staffBrowser.api.dashboards.get({ siteId, dashboardId: id })).dashboard.widgets;
	while (Date.now() < deadline && !until(widgets)) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		widgets = (await staffBrowser.api.dashboards.get({ siteId, dashboardId: id })).dashboard.widgets;
	}
	return widgets;
}

for (const theme of THEMES) {
	describe(`Dashboards, ${theme}`, () => {
		const open = async (path: string, as: TestAccount = staff, which: Theme = theme) => {
			const page = await install.newPage(which);
			await install.signIn(page, as);
			await page.goto(install.adminUrl(path));
			await page.waitForLoadState("networkidle");
			return page;
		};
		const openOverview = async (query = "") => {
			const page = await open(`/sites/${siteId}/dashboards/${dashboardId}${query}`);
			await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
			// Every Widget has counted.
			await page.getByText("Counting…").first().waitFor({ state: "detached" });
			return page;
		};

		test("a Dashboard with every shape of Widget", async () => {
			const page = await openOverview();
			await page.getByText("Spring sale started on Monday.").waitFor();
			await page.getByRole("slider", { name: /Over time/ }).waitFor();
			await page.getByRole("list", { name: "Sign-up" }).getByText("Signed up").waitFor();
			await page.getByRole("list", { name: "Devices" }).getByText("Computer").waitFor();
			// The header: who sees it, the range, Compare, Reports, Share, Arrange and the menu, each with its word.
			await page.getByText("Staff and Owners").first().waitFor();
			await page.getByRole("combobox", { name: "Days" }).waitFor();
			await page.getByRole("switch", { name: "Compare" }).waitFor();
			for (const name of ["Reports", "Share", "Arrange", "Dashboard actions"]) {
				await page.getByRole(name === "Reports" ? "link" : "button", { name, exact: true }).waitFor();
			}
			expect(await page.title()).toContain("Overview");

			await expectAccessibleScreen(page, `Dashboard (${theme})`);
		});

		test("a chart shown as a table, from the Widget's menu", async () => {
			const page = await openOverview();
			await page.getByRole("button", { name: "Actions for Over time" }).click();
			await page.getByRole("menuitem", { name: "Show as a table" }).click();
			await page.getByRole("columnheader", { name: "Start (UTC)" }).waitFor();
			await expectNoAxeViolations(page, `Dashboard › a chart as a table (${theme})`);
		});

		test("the chart's readout follows the arrow keys, listing every line", async () => {
			const page = await openOverview();
			const chart = page.getByRole("slider", { name: /Over time/ });
			await chart.focus();
			const last = await chart.getAttribute("aria-valuenow");
			expect(await chart.getAttribute("aria-valuetext")).toMatch(/Page views \d+, Visitors \d+$/);
			await page.keyboard.press("ArrowLeft");
			expect(Number(await chart.getAttribute("aria-valuenow"))).toBe(Number(last) - 1);
			await page.keyboard.press("Home");
			expect(await chart.getAttribute("aria-valuenow")).toBe("1");
		});

		test("Compare asks for the period before and says each number's change", async () => {
			const page = await openOverview();
			const compare = page.getByRole("switch", { name: "Compare" });
			await compare.focus();
			await page.keyboard.press("Space");
			await page.waitForURL(/compare=true/);
			expect(await compare.getAttribute("aria-checked")).toBe("true");
			// Nothing was counted before these visits, so there is nothing to compare with.
			await page.getByText("Nothing to compare with before").first().waitFor();
			await page.getByText("Page views, before").first().waitFor();
			await expectNoAxeViolations(page, `Dashboard › comparing (${theme})`);
		});

		test("a Widget's menu", async () => {
			const page = await openOverview();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Totals" }),
				"menu",
				`Dashboard › a Widget's menu (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Dashboard actions" }),
				"menu",
				`Dashboard › its menu (${theme})`,
			);
		});

		test("arranging: the library, adding from the keyboard, Undo and Redo, Done", async () => {
			const scratch = await scratchDashboard(`Library ${theme}`);
			const page = await open(`/sites/${siteId}/dashboards/${scratch.dashboardId}`);
			await page.getByRole("button", { name: "Arrange", exact: true }).click();
			const library = page.getByRole("complementary", { name: "Widget library" });
			await library.getByRole("searchbox", { name: "Search Widgets" }).waitFor();
			await page.getByRole("heading", { name: /Arranging/, level: 1 }).waitFor();
			await expectNoAxeViolations(page, `Dashboard › arranging (${theme})`);

			// Searching narrows the library; Enter on a kind adds it in the first free place.
			await library.getByRole("searchbox", { name: "Search Widgets" }).fill("Tot");
			await library.getByRole("button", { name: "Totals" }).focus();
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "Totals added." }).waitFor({ state: "attached" });
			await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
			expect((await savedWidgets(scratch.dashboardId, (all) => all.length === 2)).length).toBe(2);

			await page.getByRole("button", { name: "Undo", exact: true }).click();
			expect((await savedWidgets(scratch.dashboardId, (all) => all.length === 1)).length).toBe(1);
			await page.getByRole("button", { name: "Redo", exact: true }).click();
			expect((await savedWidgets(scratch.dashboardId, (all) => all.length === 2)).length).toBe(2);

			await page.getByRole("button", { name: "Done", exact: true }).click();
			await page.getByRole("button", { name: "Arrange", exact: true }).waitFor();
			expect(await library.count()).toBe(0);
		});

		test("arranging: a Widget's settings in the library's place, and removing with Undo", async () => {
			const scratch = await scratchDashboard(`Settings ${theme}`);
			await staffBrowser.api.dashboards.widgets.add({
				siteId,
				dashboardId: scratch.dashboardId,
				kind: "site-analytics:totals",
			});
			const page = await open(`/sites/${siteId}/dashboards/${scratch.dashboardId}`);
			await page.getByRole("button", { name: "Arrange", exact: true }).click();
			await page.getByRole("button", { name: "Settings of Totals" }).click();
			const panel = page.getByRole("complementary", { name: "Widget settings" });
			await panel.getByLabel("Goal", { exact: true }).waitFor();
			await panel.getByRole("option", { name: "Signed up" }).waitFor({ state: "attached" });
			await expectNoAxeViolations(page, `Dashboard › a Widget's settings (${theme})`);

			// The Widget follows its title as it changes, saved a moment later.
			await panel.getByLabel("Title").fill("Our numbers");
			await page.getByRole("heading", { name: "Our numbers", level: 2 }).waitFor();
			expect(
				(await savedWidgets(scratch.dashboardId, (all) => all.some((each) => each.title === "Our numbers"))).some(
					(each) => each.title === "Our numbers",
				),
			).toBe(true);

			// Removing goes at once; the toast's Undo puts it back.
			await page.getByRole("button", { name: "Remove Plan" }).click();
			expect((await savedWidgets(scratch.dashboardId, (all) => all.length === 1)).length).toBe(1);
			await page.getByRole("button", { name: "Undo", exact: true }).last().click();
			const back = await savedWidgets(scratch.dashboardId, (all) => all.length === 2);
			expect(back.map((each) => each.title).sort()).toEqual(["Our numbers", "Plan"]);
		});

		test("moving and resizing a Widget from the keyboard", async () => {
			const { dashboardId: id, widgetId } = await scratchDashboard(`Moves ${theme}`);
			const page = await open(`/sites/${siteId}/dashboards/${id}`);
			await page.getByRole("button", { name: "Arrange", exact: true }).click();
			const saved = async () =>
				(await staffBrowser.api.dashboards.get({ siteId, dashboardId: id })).dashboard.widgets.find(
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

			// Each step is one Undo.
			await page.getByRole("button", { name: "Undo", exact: true }).click();
			expect(await savedAs({ x: 1, y: 0, w: 5, h: 3 })).toMatchObject({ x: 1, y: 0, w: 5, h: 3 });
		});

		test("New Dashboard opens over the current one, and makes one from the keyboard", async () => {
			const page = await open(`/sites/${siteId}/dashboards`);
			const dialog = page.getByRole("dialog", { name: "New Dashboard" });
			await dialog.waitFor();
			await page.getByRole("heading", { name: "Site analytics", level: 1 }).waitFor({ state: "attached" });
			await expectNoAxeViolations(page, `New Dashboard (${theme})`, ["region"]);
			await dialog.getByRole("radio", { name: "Blank" }).waitFor({ state: "attached" });
			await page.keyboard.type(`From the keyboard ${theme}`);
			await dialog.getByText("Everyone", { exact: true }).click();
			expect(await dialog.getByRole("radio", { name: "Everyone" }).isChecked()).toBe(true);
			await dialog.getByRole("button", { name: "Create" }).click();
			await page.getByRole("heading", { name: `From the keyboard ${theme}`, level: 1 }).waitFor();
			await page.getByText("Shown to everyone").first().waitFor();
		});

		test("the built-in Dashboard is never deleted", async () => {
			const page = await open(`/sites/${siteId}/dashboards/${builtInId}`);
			await page.getByRole("heading", { name: "Site analytics", level: 1 }).waitFor();
			await page.getByRole("button", { name: "Dashboard actions" }).click();
			await page.getByRole("menuitem", { name: "Export as CSV" }).waitFor();
			await page.getByRole("menuitem", { name: "Rename" }).waitFor();
			expect(await page.getByRole("menuitem", { name: "Delete Dashboard" }).count()).toBe(0);
		});

		test("an Owner sees no Arrange, and the menu has Export as CSV only", async () => {
			const page = await open(`/sites/${siteId}/dashboards/${dashboardId}`, owner);
			await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
			await page.getByRole("switch", { name: "Compare" }).waitFor();
			expect(await page.getByRole("button", { name: "Arrange", exact: true }).count()).toBe(0);
			await page.getByRole("button", { name: "Dashboard actions" }).click();
			await page.getByRole("menuitem", { name: "Export as CSV" }).waitFor();
			expect(await page.getByRole("menuitem", { name: "Rename" }).count()).toBe(0);
		});

		test("on a phone: one column in reading order, no arranging", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(install.adminUrl(`/sites/${siteId}/dashboards/${dashboardId}`));
			await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
			await page.getByText("Counting…").first().waitFor({ state: "detached" });
			expect(await page.getByRole("button", { name: "Arrange", exact: true }).isVisible()).toBe(false);
			const lefts = await page
				.getByRole("list", { name: "Widgets of Overview" })
				.locator(":scope > li")
				.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().left)));
			expect(new Set(lefts).size).toBe(1);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			await expectNoAxeViolations(page, `Dashboard on a phone (${theme})`);
		});

		test("a Workspace Dashboard adding up its Sites", async () => {
			const page = await open(`/workspaces/${workspaceId}/dashboards/${workspaceDashboardId}`);
			await page.getByRole("heading", { name: "All Sites", level: 1 }).waitFor();
			await page.getByText("Adds up the 1 Site of Acme Ltd.").waitFor();
			await page.getByText("Counting…").first().waitFor({ state: "detached" });
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
