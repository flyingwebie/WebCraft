import { afterEach, describe, expect, test } from "bun:test";

import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall | undefined;

afterEach(async () => {
	await install?.close();
	install = undefined;
});

for (const theme of THEMES) {
	describe(`the setup wizard, ${theme}`, () => {
		test("every step, and a refused password, pass the checks", async () => {
			install = await startBrowserInstall();
			const page = await install.newPage(theme);

			await page.goto(install.adminUrl("/setup"));
			await page.waitForLoadState("networkidle");
			await expectAccessibleScreen(page, `setup token step (${theme})`);

			await page.locator("#setup-token").fill("not the token");
			await page.locator("form button[type=submit]").click();
			await page.locator("#setup-token-error").waitFor();
			await expectAccessibleScreen(page, `setup token step, refused (${theme})`);

			await page.locator("#setup-token").fill(install.setupToken());
			await page.locator("form button[type=submit]").click();
			await page.locator("#account-name").waitFor();
			expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
			await expectAccessibleScreen(page, `Superadmin account step (${theme})`);

			await page.locator("#account-name").fill("Ada Lovelace");
			await page.locator("#account-email").fill("ada@agency.example");
			await page.locator("#account-password").fill("too short");
			await page.locator("form button[type=submit]").click();
			await page.locator("#account-password-error").waitFor();
			await expectAccessibleScreen(page, `Superadmin account step, refused password (${theme})`);

			await page.locator("#account-password").fill("a long enough password");
			await page.locator("form button[type=submit]").click();
			await page.getByRole("heading", { level: 1, name: /two-factor/i }).waitFor();
			await expectAccessibleScreen(page, `two-factor step (${theme})`);

			await page.getByRole("button", { name: "Continue" }).click();
			await page.getByRole("heading", { level: 1, name: "Set up the Install email" }).waitFor();
			await page.locator("#smtp-host").waitFor();
			await expectAccessibleScreen(page, `Install email step (${theme})`);

			await page.getByRole("button", { name: "Save and finish" }).click();
			await page.locator("#smtp-host-error").waitFor();
			await expectAccessibleScreen(page, `Install email step, refused (${theme})`);

			await page.getByRole("button", { name: "Skip for now" }).click();
			await page.waitForURL((url) => url.pathname === "/");
		});

		test("the link printed in the log opens the account step and leaves the token out of the address", async () => {
			install = await startBrowserInstall();
			const page = await install.newPage(theme);

			await page.goto(install.adminUrl(`/setup?token=${install.setupToken()}`));
			await page.locator("#account-name").waitFor();

			expect(new URL(page.url()).search).toBe("");
			await expectAccessibleScreen(page, `Superadmin account step from the link (${theme})`);
		});
	});
}
