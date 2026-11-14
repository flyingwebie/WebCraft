// Reports and Share links in a real browser (#104, UI-16): a Dashboard's Reports page with what its
// Reports sent (as Staff and as an Owner), the New Report sheet and a Report's menu, a Report's Active
// switch from the keyboard, an Owner changing recipients ("Confirm it's you": a Sensitive action), a
// Report held for review in its sheet, the Share links sheet with a link made from the keyboard (its
// whole address once) and one revoked with a second press, and the Share link's own page at phone and
// desktop widths and its password page (also after a wrong password), in light and dark.
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
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.2.0" });
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
	// Made through the Install in the test process, whose sites domain differs: the same link on the web process's.
	const served = (url: string) => install.siteUrl("share", new URL(url).pathname);
	openUrl = served((await api.shareLinks.create({ siteId, dashboardId, name: "For the client", language: "en" })).url);
	lockedUrl = served(
		(await api.shareLinks.create({ siteId, dashboardId, name: "For the board", password: PASSWORD })).url,
	);

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

		test("a Dashboard's Reports and what they sent, as Staff", async () => {
			const page = await open(reportsPath());
			await page.getByRole("heading", { name: "Reports", level: 1 }).waitFor();
			await page.getByText("Scheduled summaries of Overview, sent by email.").waitFor();
			await page.getByRole("cell", { name: "Weekly", exact: true }).waitFor();
			// How many it goes to (an Owner adds one in the light run).
			await page.getByRole("cell", { name: /^\d+ recipients?$/ }).waitFor();
			await page.getByRole("heading", { name: "Sent", level: 2 }).waitFor();
			// Each send says its state in words, with what can be done with it.
			await page.getByText("Waiting for your review", { exact: true }).waitFor();
			await page.getByRole("link", { name: /^Review the Report for / }).waitFor();
			await page
				.getByRole("button", { name: /^Download PDF for / })
				.first()
				.waitFor();

			await expectAccessibleScreen(page, `Reports (${theme})`);
		});

		test("a Dashboard's Reports, as an Owner", async () => {
			const page = await open(reportsPath(), owner);
			await page.getByRole("heading", { name: "Reports", level: 1 }).waitFor();
			expect(await page.getByRole("button", { name: "New Report" }).count()).toBe(0);
			// Owners see whether a Report goes out; only Staff switch it.
			expect(await page.getByRole("switch", { name: "Send Weekly results on its schedule" }).isDisabled()).toBe(true);

			await expectAccessibleScreen(page, `Reports, an Owner (${theme})`);
		});

		test("the New Report sheet and a Report's menu", async () => {
			const page = await open(reportsPath());
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "New Report" }),
				"dialog",
				`New Report sheet (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Weekly results" }),
				"menu",
				`A Report's menu (${theme})`,
			);
		});

		test("an Owner changing who gets a Report confirms it's you first, from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signInWithOldIdentityCheck(page, owner, 20);
			await page.goto(install.adminUrl(reportsPath()));
			await page.waitForLoadState("networkidle");
			await page.getByRole("button", { name: "Actions for Weekly results" }).click();
			await page.getByRole("menuitem", { name: "Change recipients" }).click();
			const dialog = page.getByRole("dialog", { name: "Recipients of Weekly results" });
			await dialog.getByRole("textbox").fill(`client@bakery.example\nmanager-${theme}@bakery.example`);
			await dialog.getByRole("button", { name: "Save" }).focus();
			await page.keyboard.press("Enter");

			const check = page.getByRole("dialog", { name: "Confirm it's you" });
			await check.waitFor();
			await page.waitForFunction(() => document.activeElement?.id === "identity-check-password");
			await expectNoAxeViolations(page, `Reports › Confirm it's you (${theme})`, ["region"]);
			await page.keyboard.type(owner.password);
			await page.keyboard.press("Enter");
			await page.getByText("The recipients of Weekly results were saved.").waitFor();

			const { reports } = await (await install.install.superadmin()).api.reports.list({ siteId, dashboardId });
			expect(reports.find((found) => found.id === reportId)?.recipients).toContain(`manager-${theme}@bakery.example`);
		});

		test("a Report waiting for review, in its sheet", async () => {
			// The address the email about it links to still opens it.
			const page = await open(`${reportsPath()}?report=${reportId}&review=${heldId}`);
			const sheet = page.getByRole("dialog", { name: "Review before it goes" });
			await sheet.waitFor();
			expect(await sheet.getByLabel("What happened").inputValue()).toBe(
				"A steady week, with visitors finding the menu.",
			);
			// A line per Widget, and each suggestion with the Service it points to.
			await sheet.getByText("Steady, with a few more visits.").first().waitFor();
			await sheet.getByText("Write a page about the menu.").waitFor();
			await sheet.getByText("Search engine optimisation").waitFor();
			await sheet.getByRole("button", { name: "Approve and send" }).waitFor();
			await page.waitForTimeout(250);

			// The sheet sits at the end of the page, outside the landmarks, as dialogs do.
			await expectNoAxeViolations(page, `Review sheet (${theme})`, ["region"]);
			// Staff may change the text before it goes.
			await sheet.getByRole("button", { name: "Change the text" }).click();
			await sheet.getByLabel("Suggestion 1").waitFor();
			await expectNoAxeViolations(page, `Review sheet, changing the text (${theme})`, ["region"]);
		});

		test("the Share links sheet", async () => {
			const page = await open(`/sites/${siteId}/dashboards/${dashboardId}`);
			await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Share" }),
				"dialog",
				`Share links sheet (${theme})`,
			);
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
			// Autofocus lands just after the page loads.
			await page.waitForFunction(() => document.activeElement?.id === "password", undefined, { timeout: 5000 });
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
		const sheet = page.getByRole("dialog", { name: "Share links" });
		await sheet.getByLabel("Name").focus();
		await page.keyboard.type("For the shop");
		await page.keyboard.press("Enter");
		const address = sheet.getByLabel("Its address");
		await address.waitFor();
		expect(await address.inputValue()).toMatch(/^http:\/\/share\.sites\.localhost:\d+\/[A-Za-z0-9_-]{43}$/);
		// Focus is on the address, to copy it; it is shown this once.
		await page.waitForFunction(() =>
			(document.activeElement as HTMLInputElement | null)?.value?.startsWith("http://share."),
		);
		await sheet.getByText("Shown once. Copy it now.").waitFor();
		// A new link works for 30 days unless Staff choose otherwise.
		const { links } = await (await install.install.superadmin()).api.shareLinks.list({ siteId, dashboardId });
		const made = links.find((link) => link.name === "For the shop");
		expect(made?.expiresAt).not.toBeNull();
		const days = (new Date(made?.expiresAt ?? 0).getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(29);
		expect(days).toBeLessThan(32);
	});

	test("Staff revoke a Share link with a second press", async () => {
		const api = (await install.install.superadmin()).api;
		const page = await install.newPage("light");
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/dashboards/${dashboardId}`));
		await page.getByRole("button", { name: "Share" }).click();
		const sheet = page.getByRole("dialog", { name: "Share links" });
		await sheet.getByLabel("Name").fill("For the old agency");
		await sheet.getByRole("button", { name: "Create" }).click();
		await sheet.getByLabel("Its address").waitFor();
		const revoke = sheet.getByRole("button", { name: "Revoke For the old agency" });
		await revoke.focus();
		await page.keyboard.press("Enter");
		// The first press only asks: the same button now says what a second press does.
		await sheet.getByRole("button", { name: "Revoke For the old agency for good: it stops working" }).waitFor();
		const still = (await api.shareLinks.list({ siteId, dashboardId })).links.find(
			(link) => link.name === "For the old agency",
		);
		expect(still?.state).toBe("active");
		await page.keyboard.press("Enter");
		await page.getByText("For the old agency no longer works.").waitFor();
		const gone = (await api.shareLinks.list({ siteId, dashboardId })).links.find(
			(link) => link.name === "For the old agency",
		);
		expect(gone?.state).toBe("revoked");
	});

	test("Staff switch a Report off and on again from the keyboard", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/dashboards/${dashboardId}/reports`));
		await page.waitForLoadState("networkidle");
		const active = page.getByRole("switch", { name: "Send Weekly results on its schedule" });
		expect(await active.isChecked()).toBe(true);
		await active.focus();
		await page.keyboard.press("Space");
		await page.getByText("Weekly results no longer goes out on its schedule.").waitFor();
		const api = (await install.install.superadmin()).api;
		const off = (await api.reports.list({ siteId, dashboardId })).reports.find((report) => report.id === reportId);
		expect(off?.active).toBe(false);
		await page.getByRole("switch", { name: "Send Weekly results on its schedule" }).focus();
		await page.keyboard.press("Space");
		await page.getByText("Weekly results goes out on its schedule again.").waitFor();
		const on = (await api.reports.list({ siteId, dashboardId })).reports.find((report) => report.id === reportId);
		expect(on?.active).toBe(true);
	});
});
