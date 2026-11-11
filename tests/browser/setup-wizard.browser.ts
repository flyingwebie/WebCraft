import { afterEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { totpCode } from "../harness/two-factor.ts";
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

			// The step really sets it up: an authenticator app, from its key, then the backup codes.
			await page.getByRole("button", { name: "Set up an authenticator app" }).click();
			await page.getByRole("img", { name: /QR code adding/ }).waitFor();
			const key = ((await page.locator("#authenticator-key").textContent()) ?? "").replace(/\s/g, "");
			await page.locator("#authenticator-code").fill(totpCode(key, new Date()));
			await page.getByRole("button", { name: "Add app" }).click();
			await page.getByRole("button", { name: "I've saved them" }).click();
			await page.getByText("Two-factor authentication is on for your account.").waitFor();
			await expectAccessibleScreen(page, `two-factor step, set up (${theme})`);

			// Its toast goes after a few seconds: wait, so it can't vanish between two later checks.
			await page.getByText("Authenticator app added.").waitFor({ state: "hidden" });
			await page.getByRole("button", { name: "Continue" }).click();
			await page.getByRole("heading", { level: 1, name: "Set up the Install email" }).waitFor();
			await page.locator("#smtp-host").waitFor();
			await expectAccessibleScreen(page, `Install email step (${theme})`);

			await page.getByRole("button", { name: "Save and continue" }).click();
			await page.locator("#smtp-host-error").waitFor();
			await expectAccessibleScreen(page, `Install email step, refused (${theme})`);

			await page.getByRole("button", { name: "Skip for now" }).click();
			await page.getByRole("heading", { level: 1, name: "Approve the Modules" }).waitFor();
			await page.getByRole("checkbox", { name: /Sample notes/ }).waitFor();
			await expectAccessibleScreen(page, `Modules step (${theme})`);

			await page.getByText("What Sample notes asks for").click();
			await expectAccessibleScreen(page, `Modules step, a Module's details open (${theme})`);

			// Modules no longer finishes setup: the first client step comes next.
			await page.getByRole("button", { name: "Approve and continue" }).click();
			await page.getByRole("heading", { level: 1, name: "Add your first client" }).waitFor();
			expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
			await expectAccessibleScreen(page, `first client step (${theme})`);

			await page.getByRole("button", { name: "Create and finish" }).click();
			await page.locator("#first-workspace-name-error").waitFor();
			expect(await page.locator("#first-workspace-name-error").textContent()).toBe("Enter a name.");
			await expectAccessibleScreen(page, `first client step, no Workspace name (${theme})`);

			await page.locator("#first-workspace-name").fill("Acme Ltd");
			await page.locator("#first-site-name").fill("Acme Bakery");
			expect(await page.locator("#first-site-slug").inputValue()).toBe("acme-bakery");
			await page.locator("#first-site-slug").fill("admin");
			await page.getByRole("button", { name: "Create and finish" }).click();
			await page.locator("#first-site-slug-error").waitFor();
			expect(await page.locator("#first-site-slug-error").textContent()).toBe(
				"This slug is kept for the Install itself. Choose another one.",
			);
			expect(new URL(page.url()).pathname).toBe("/setup");
			await expectAccessibleScreen(page, `first client step, refused slug (${theme})`);

			await page.locator("#first-site-slug").fill("acme-bakery");
			await page.locator("#first-site-slug").press("Enter");
			await page.waitForURL((url) => url.pathname.startsWith("/sites/"));
			await page.getByRole("heading", { level: 1, name: /Acme Bakery/ }).waitFor();
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

/** Signs in through the wizard's first steps, skipping what can be skipped, up to the first client step. */
async function toFirstClientStep(page: Page, setupToken: string) {
	await page.locator("#setup-token").fill(setupToken);
	await page.locator("form button[type=submit]").click();
	await page.locator("#account-name").fill("Ada Lovelace");
	await page.locator("#account-email").fill("ada@agency.example");
	await page.locator("#account-password").fill("a long enough password");
	await page.locator("form button[type=submit]").click();
	await page.getByRole("button", { name: "Skip for now" }).click();
	await page.getByRole("heading", { level: 1, name: "Set up the Install email" }).waitFor();
	await page.getByRole("button", { name: "Skip for now" }).click();
	await page.getByRole("checkbox", { name: /Sample notes/ }).waitFor();
	await page.getByRole("button", { name: "Approve and continue" }).click();
	await page.getByRole("heading", { level: 1, name: "Add your first client" }).waitFor();
}

describe("the setup wizard's first client step", () => {
	test("from the keyboard, without its Site: it creates the Workspace and opens it", async () => {
		install = await startBrowserInstall();
		const page = await install.newPage("light");
		await page.goto(install.adminUrl("/setup"));
		await toFirstClientStep(page, install.setupToken());

		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("first-workspace-name");
		await page.keyboard.type("Acme Ltd");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Space");
		expect(await page.getByRole("checkbox", { name: "Also create its first Site" }).isChecked()).toBe(false);
		await expect(page.locator("#first-site-name").count()).resolves.toBe(0);
		await page.locator("#first-workspace-name").press("Enter");

		await page.waitForURL((url) => url.pathname.startsWith("/workspaces/"));
		await page.getByText("Acme Ltd").first().waitFor();
	});

	test("Skip for now finishes setup without creating anything and opens the dashboard", async () => {
		install = await startBrowserInstall();
		const page = await install.newPage("dark");
		await page.goto(install.adminUrl("/setup"));
		await toFirstClientStep(page, install.setupToken());

		await page.getByRole("button", { name: "Skip for now" }).click();

		await page.waitForURL((url) => url.pathname === "/");
		await page.goto(install.adminUrl("/setup"));
		await page.getByRole("heading", { level: 1, name: "Add your first client" }).waitFor({ state: "detached" });
		expect(await page.getByRole("heading", { level: 1, name: "Add your first client" }).count()).toBe(0);
	});
});
