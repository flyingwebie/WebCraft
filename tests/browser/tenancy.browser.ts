// The dialogs and panels of the Workspaces, Staff, Members and Sites screens, and the context
// switcher at the Workspace and Site levels, from the keyboard.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { inviteLinkIn, type TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let workspaceId: string;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
	await install.install.createWorkspace("Nimbus Bikes");
	siteId = (await install.install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await install.install.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" });
	await install.install.createMember({ workspaceId, role: "editor", name: "Giulia Romano" });
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

		test("the Invite Member panel opens and closes from the keyboard, and its Site list passes axe", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/workspaces/${workspaceId}/members`));
			await page.waitForLoadState("networkidle");
			const trigger = page.getByRole("button", { name: "Invite Member" });

			await expectOverlayUsable(page, trigger, "dialog", `Invite Member (${theme})`);

			await trigger.click();
			await page.getByRole("radio", { name: "Chosen Sites" }).click();
			await page.getByRole("checkbox", { name: "Acme Bakery" }).waitFor();
			await page.getByRole("dialog").locator("button[type=submit]").click();
			await page.getByText("Choose at least one Site.").waitFor();
			await expectNoAxeViolations(page, `Invite Member, chosen Sites (${theme})`, ["region"]);
		});

		test("a Member's menu, its Change role and Sites panel and its Remove dialog work from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/workspaces/${workspaceId}/members`));
			await page.waitForLoadState("networkidle");
			const trigger = page.getByRole("button", { name: "Actions for Giulia Romano" });

			await expectOverlayUsable(page, trigger, "menu", `Member actions (${theme})`);

			for (const [item, where] of [
				["Change role and Sites", "Change role and Sites"],
				["Remove from Workspace", "Remove a Member"],
			] as const) {
				await trigger.focus();
				await page.keyboard.press("Enter");
				await page.getByRole("menuitem", { name: item }).waitFor();
				await page.getByRole("menuitem", { name: item }).focus();
				await page.keyboard.press("Enter");
				const dialog = page.getByRole("dialog");
				await dialog.waitFor({ state: "visible" });
				await page.waitForTimeout(250);
				await expectNoAxeViolations(page, `${where} (${theme})`, ["region"]);
				expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

				await page.keyboard.press("Escape");
				await dialog.waitFor({ state: "hidden" });
				expect({ where, focusBack: await trigger.evaluate((element) => element === document.activeElement) }).toEqual({
					where,
					focusBack: true,
				});
			}
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
		const admin = await install.install.superadmin();
		await admin.api.staff.invite({ email: "aoife@agency.example", workspaces: [workspaceId] });
		const link = new URL(inviteLinkIn(await install.install.lastEmailTo("aoife@agency.example")));
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

describe("accepting a Member invite", () => {
	test("a new person creates their account and lands in the Workspace", async () => {
		const admin = await install.install.superadmin();
		await admin.api.members.invite({ workspaceId, email: "niamh@acme.example", role: "author", sites: [siteId] });
		const link = new URL(inviteLinkIn(await install.install.lastEmailTo("niamh@acme.example")));
		const page = await install.newPage("light");

		await page.goto(install.adminUrl(`/invite${link.search}`));
		await page.getByRole("heading", { level: 1, name: "Join Acme Ltd as Author" }).waitFor();
		await page.locator("#invite-name").fill("Niamh Walsh");
		await page.locator("#invite-password").fill("a long enough password");
		await page.locator("form button[type=submit]").click();

		await page.waitForURL((url) => url.pathname === `/workspaces/${workspaceId}`);
		await page.getByRole("heading", { level: 1, name: "Sites" }).waitFor();
		// Authors don't manage Members: the sidebar leaves the Members screen out.
		await expect(page.getByRole("link", { name: "Members" }).count()).resolves.toBe(0);
	});

	test("a person with an account signs in on the invite page and joins; a wrong password shows accessibly", async () => {
		const nimbus = await install.install.createWorkspace("Nimbus Join");
		const member = await install.install.createMember({ workspaceId, role: "author", name: "Tom Byrne" });
		const admin = await install.install.superadmin();
		await admin.api.members.invite({
			workspaceId: nimbus.id,
			email: member.account.email,
			role: "owner",
			sites: "all",
		});
		const link = new URL(inviteLinkIn(await install.install.lastEmailTo(member.account.email)));
		const page = await install.newPage("dark");

		await page.goto(install.adminUrl(`/invite${link.search}`));
		await page.locator("#invite-join-password").fill("not the password");
		await page.locator("form button[type=submit]").click();
		await page.locator("#invite-join-error").waitFor();
		await expectAccessibleScreen(page, "Join a Workspace, wrong password");

		await page.locator("#invite-join-password").fill(member.account.password);
		await page.locator("form button[type=submit]").click();
		await page.waitForURL((url) => url.pathname === `/workspaces/${nimbus.id}`);
		// Owners manage Members: the sidebar shows the Members screen.
		await page.getByRole("link", { name: "Members" }).waitFor();
	});
});
