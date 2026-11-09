// Reports and Share links in a real browser (#104): a Dashboard's Reports page with its history (as
// Staff and as an Owner), the Report dialog and a Report's menu, a Report held for review, the Share
// dialog with a link made from the keyboard, and the Share link's own page at phone and desktop widths
// and its password page (also after a wrong password), in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsVisitor } from "../harness/analytics.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let owner: TestAccount;
let siteId: string;
let dashboardId: string;
let heldId: string;
let reportId: string;
let openUrl: string;
let lockedUrl: string;
const PASSWORD = "the client's password";

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	// The web process counts by the real clock: the visits come now too.
	await local.clock.set(new Date());
	const admin = await local.superadmin();
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await install.goLive(siteId);
	await admin.api.modules.setOnSite({ siteId, moduleId: "site-analytics", on: true });
	await admin.api.consentBanner.setSettings({ siteId, mode: "none", layout: "bar" });
	const member = await local.createStaff({ workspaces: [workspaceId] });
	staff = member.account;
	const ownerMember = await local.createMember({ workspaceId, role: "owner" });
	owner = ownerMember.account;
	await ownerMember.browser.api.aiKeys.setOwn({
		workspaceId,
		provider: "openai",
		model: "gpt-5-mini",
		endpoint: null,
		key: "sk-test-key-of-the-client-0123456789",
	});
	await member.browser.api.servicesList.update({ services: [{ name: "Search engine optimisation" }] });

	const origin = new URL(install.liveUrl("bakery", "/")).origin;
	for (const [address, path] of [
		["203.0.113.20", "/"],
		["198.51.100.21", "/menu"],
	] as const) {
		await analyticsVisitor(local, origin, { address }).view(path);
	}
	const api = member.browser.api;
	const { dashboard } = await api.dashboards.create({ siteId, name: "Overview" });
	dashboardId = dashboard.id;
	await api.dashboards.widgets.add({ siteId, dashboardId, kind: "site-analytics:totals" });
	await api.dashboards.widgets.add({ siteId, dashboardId, kind: "site-analytics:trend" });
	await api.dashboards.widgets.add({ siteId, dashboardId, kind: "site-analytics:top-pages" });
	openUrl = (await api.shareLinks.create({ siteId, dashboardId, name: "For the client", language: "en" })).url;
	lockedUrl = (await api.shareLinks.create({ siteId, dashboardId, name: "For the board", password: PASSWORD })).url;

	const { report } = await api.reports.create({
		siteId,
		dashboardId,
		name: "Weekly results",
		schedule: "weekly",
		language: "en",
		recipients: ["client@bakery.example"],
		review: true,
		active: true,
	});
	reportId = report.id;
	await api.reports.sendTest({ siteId, reportId });
	local.ai.reportWith((request) => {
		const facts = JSON.parse(request.facts) as { widgets: { id: string }[] };
		return {
			widgets: Object.fromEntries(facts.widgets.map((widget) => [widget.id, "Steady, with a few more visits."])),
			whatHappened: "A steady week, with visitors finding the menu.",
			suggestions: [{ text: "Write a page about the menu.", service: request.services[0]?.id ?? null }],
		};
	});
	await local.drainJobs();
	// The Report's Monday comes, and it waits for review.
	await local.clock.set(report.nextRunAt ?? new Date());
	await local.drainJobs();
	const { sends } = await api.reports.history({ siteId, reportId }).catch(async () => {
		const fresh = await local.signIn(staff);
		return fresh.api.reports.history({ siteId, reportId });
	});
	heldId = sends.find((send) => send.status === "review")?.id ?? "";
	expect(heldId).not.toBe("");
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Reports, ${theme}`, () => {
		const reportsPath = () => `/sites/${siteId}/dashboards/${dashboardId}/reports`;
		const open = async (path: string, as: TestAccount = staff) => {
			const page = await install.newPage(theme);
			await install.signIn(page, as);
			await page.goto(install.adminUrl(path));
			await page.waitForLoadState("networkidle");
			return page;
		};

		test("a Dashboard's Reports and a Report's history, as Staff", async () => {
			const page = await open(reportsPath());
			await page.getByRole("heading", { name: "Reports of Overview", level: 1 }).waitFor();
			await page.getByRole("heading", { name: "History of Weekly results" }).waitFor();
			await page.getByRole("button", { name: "Review" }).waitFor();

			await expectAccessibleScreen(page, `Reports (${theme})`);
		});

		test("a Dashboard's Reports, as an Owner", async () => {
			const page = await open(reportsPath(), owner);
			await page.getByRole("heading", { name: "Reports of Overview", level: 1 }).waitFor();
			expect(await page.getByRole("button", { name: "New Report" }).count()).toBe(0);

			await expectAccessibleScreen(page, `Reports, an Owner (${theme})`);
		});

		test("the Report dialog and a Report's menu", async () => {
			const page = await open(reportsPath());
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "New Report" }),
				"dialog",
				`Report dialog (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Weekly results" }),
				"menu",
				`A Report's menu (${theme})`,
			);
		});

		test("a Report waiting for review", async () => {
			const page = await open(`${reportsPath()}?report=${reportId}&review=${heldId}`);
			const dialog = page.getByRole("dialog", { name: "Review the AI text" });
			await dialog.waitFor();
			expect(await dialog.getByLabel("What happened").inputValue()).toBe(
				"A steady week, with visitors finding the menu.",
			);
			await page.waitForTimeout(250);

			// The dialog sits at the end of the page, outside the landmarks, as dialogs do.
			await expectNoAxeViolations(page, `Review dialog (${theme})`, ["region"]);
		});

		test("the Share dialog", async () => {
			const page = await open(`/sites/${siteId}/dashboards/${dashboardId}`);
			await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
			await expectOverlayUsable(page, page.getByRole("button", { name: "Share" }), "dialog", `Share dialog (${theme})`);
		});

		test("a Share link's page, at desktop and phone widths", async () => {
			const page = await install.newPage(theme);
			await page.goto(openUrl);
			await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
			await expectAccessibleScreen(page, `Share link page (${theme})`);

			await page.setViewportSize({ width: 375, height: 800 });
			await page.reload();
			await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			await expectAccessibleScreen(page, `Share link page, phone (${theme})`);
		});

		test("a Share link's password page, and after a wrong password", async () => {
			const page = await install.newPage(theme);
			await page.goto(lockedUrl);
			await page.getByRole("heading", { name: "This Dashboard is protected" }).waitFor();
			await expectAccessibleScreen(page, `Share link password (${theme})`);

			await page.getByLabel("Password").fill("not the password");
			await page.keyboard.press("Enter");
			await page.getByRole("alert").waitFor();
			expect(await page.title()).toStartWith("Error:");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("password");
			await expectAccessibleScreen(page, `Share link password, wrong (${theme})`);
		});
	});
}

describe("from the keyboard", () => {
	test("the password opens a Share link's Dashboard", async () => {
		const page = await install.newPage("light");
		await page.goto(lockedUrl);
		await page.getByLabel("Password").focus();
		await page.keyboard.type(PASSWORD);
		await page.keyboard.press("Enter");
		await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
		expect(page.url()).toBe(lockedUrl);
	});

	test("Staff make a Share link and see its address once", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/dashboards/${dashboardId}`));
		await page.getByRole("button", { name: "Share" }).focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog", { name: "Share links" });
		await dialog.getByRole("button", { name: "New Share link" }).focus();
		await page.keyboard.press("Enter");
		await dialog.getByLabel("Name").focus();
		await page.keyboard.type("For the shop");
		await page.keyboard.press("Enter");
		const address = dialog.getByLabel("Its address");
		await address.waitFor();
		expect(await address.inputValue()).toMatch(/^http:\/\/share\.sites\.localhost:\d+\/[A-Za-z0-9_-]{43}$/);
	});
});
