// "Confirm it's you" (the recent identity check before a Sensitive action) and Your account's
// password and sessions, from the keyboard.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let invited = 0;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	await install.install.createWorkspace("Acme Ltd");
	// Other browsers signed in as the Superadmin, so Your account › Sessions lists several.
	await install.install.signIn(superadmin, {
		address: "203.0.113.24",
		userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0",
	});
	await install.install.signIn(superadmin, { address: "2001:db8:85a3::7334", userAgent: "curl/8.0" });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Confirm it's you, ${theme}`, () => {
		test("a Sensitive action asks for the password in a dialog; Escape cancels it and changes nothing", async () => {
			const page = await install.newPage(theme);
			await install.signInWithOldIdentityCheck(page, superadmin, 20);
			await page.goto(install.adminUrl("/settings/security"));
			await page.waitForLoadState("networkidle");
			await page.getByRole("checkbox", { name: /leaked passwords/ }).uncheck();

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Save" }),
				"dialog",
				`Confirm it's you (${theme})`,
			);

			await page.getByText("Nothing was changed: confirm it's you to continue.").waitFor();
			expect(await install.install.superadmin().then((admin) => admin.api.install.security.get())).toEqual({
				leakedPasswordCheck: true,
			});
		});

		test("a wrong password is shown in the dialog; the right one lets the action through, even from a panel", async () => {
			const page = await install.newPage(theme);
			await install.signInWithOldIdentityCheck(page, superadmin, 20);
			await page.goto(install.adminUrl("/staff"));
			await page.waitForLoadState("networkidle");
			await page.getByRole("button", { name: "Invite Staff" }).click();
			const email = `invited-${theme}-${++invited}@agency.example`;
			await page.getByRole("textbox", { name: "Email" }).fill(email);
			await page.getByRole("button", { name: "Send invite" }).click();

			const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
			await dialog.waitFor();
			await page.waitForFunction(() => document.activeElement?.id === "identity-check-password");
			await page.keyboard.type("not the right password");
			await page.keyboard.press("Enter");
			await dialog.getByText("That password is wrong.").waitFor();
			await expectNoAxeViolations(page, `Confirm it's you, wrong password (${theme})`, ["region"]);

			await dialog.getByLabel("Password", { exact: true }).fill(superadmin.password);
			await page.keyboard.press("Enter");
			await dialog.waitFor({ state: "hidden" });
			await page.getByText(email).first().waitFor();
		});
	});

	describe(`Your account, ${theme}`, () => {
		test("a refused new password passes the checks", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/account"));
			await page.waitForLoadState("networkidle");

			await page.getByLabel("New password", { exact: true }).fill("a new long enough password");
			await page.getByLabel("Repeat the new password").fill("a different long password");
			await page.getByRole("button", { name: "Change password" }).click();
			await page.getByText("The passwords don't match.").waitFor();

			await expectAccessibleScreen(page, `Your account, passwords don't match (${theme})`);
		});
	});
}
