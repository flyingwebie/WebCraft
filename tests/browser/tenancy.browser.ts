// The dialogs and panels of the Workspaces, Staff and Sites screens, and the context switcher at
// the Workspace and Site levels, from the keyboard.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let workspaceId: string;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	workspaceId = (await install.local.createWorkspace("Acme Ltd")).id;
	await install.local.createWorkspace("Nimbus Bikes");
	siteId = (await install.local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await install.local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Workspaces, Staff and Sites, ${theme}`, () => {
		test("the New Workspace dialog opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/workspaces"));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "New Workspace" }),
				"dialog",
				`New Workspace (${theme})`,
			);
		});

		test("the Invite Staff panel opens and closes from the keyboard, and its Workspace list passes axe", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/staff"));
			await page.waitForLoadState("networkidle");
			const trigger = page.getByRole("button", { name: "Invite Staff" });

			await expectOverlayUsable(page, trigger, "dialog", `Invite Staff (${theme})`);

			await trigger.click();
			await page.getByRole("radio", { name: "Chosen Workspaces" }).click();
			await page.getByRole("checkbox", { name: "Acme Ltd" }).waitFor();
			await expectNoAxeViolations(page, `Invite Staff, chosen Workspaces (${theme})`, ["region"]);
		});

		test("the Change Workspaces panel opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/staff"));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Change Workspaces for Ciara Byrne" }),
				"dialog",
				`Change Workspaces (${theme})`,
			);
		});

		test("the New Site dialog opens and closes from the keyboard, and shows a refused slug accessibly", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/workspaces/${workspaceId}`));
			await page.waitForLoadState("networkidle");
			const trigger = page.getByRole("button", { name: "New Site" });

			await expectOverlayUsable(page, trigger, "dialog", `New Site (${theme})`);

			await trigger.click();
			await page.locator("#site-name").fill("Acme Bakery");
			expect(await page.locator("#site-slug").inputValue()).toBe("acme-bakery");
			await page.locator("#site-slug").fill("bakery");
			await page.getByRole("dialog").locator("button[type=submit]").click();
			await page.locator("#site-slug-error").waitFor();
			await expectNoAxeViolations(page, `New Site, slug taken (${theme})`, ["region"]);
		});

		test("the context switcher opens from the keyboard at the Workspace and Site levels", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);

			for (const [level, path] of [
				["Workspace", `/workspaces/${workspaceId}`],
				["Site", `/sites/${siteId}`],
			] as const) {
				await page.goto(install.adminUrl(path));
				await page.waitForLoadState("networkidle");
				await expectOverlayUsable(
					page,
					page.getByRole("button", { name: /Switch Workspace or Site/ }),
					"menu",
					`context switcher, ${level} level (${theme})`,
				);
			}
		});
	});
}

describe("accepting an invite", () => {
	test("the link opens the form and leaves the token out of the address; accepting signs the person in", async () => {
		const admin = await install.local.superadmin();
		await admin.api.staff.invite({ email: "aoife@agency.example", workspaces: [workspaceId] });
		const email = install.local.mail.sent.findLast((sent) => sent.to === "aoife@agency.example");
		const link = new URL(email?.text.match(/https:\/\/\S+\/invite\?token=\S+/)?.[0] ?? "");
		const page = await install.newPage("light");

		await page.goto(install.adminUrl(`/invite${link.search}`));
		await page.locator("#invite-name").waitFor();
		await page.waitForURL((url) => url.search === "");

		await page.locator("#invite-name").fill("Aoife Kelly");
		await page.locator("#invite-password").fill("too short");
		await page.locator("form button[type=submit]").click();
		await page.locator("#invite-password-error").waitFor();
		await expectAccessibleScreen(page, "Accept an invite, refused password");

		await page.locator("#invite-password").fill("a long enough password");
		await page.locator("form button[type=submit]").click();
		await page.waitForURL((url) => url.pathname === "/");
		await page.getByRole("heading", { level: 1, name: "Overview" }).waitFor();
		await expect(page.getByText("Staff", { exact: false }).first().isVisible()).resolves.toBe(true);
	});
});
