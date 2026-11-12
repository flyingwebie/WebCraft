// Password recovery in the admin, in light and dark, served by the production web process under
// the admin's Content Security Policy: "Forgot your password?" on the sign-in page, asking for a
// link, and choosing a new password with it. Behaviour is tested at seam 1 (tests/auth).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let workspaceId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
});

afterAll(async () => {
	await install.close();
});

/** The reset link the person was last emailed, on the address the browser reaches the admin at. */
async function resetLinkFor(email: string): Promise<string> {
	// The web process queued the job by the real clock: the test Install's clock catches up first.
	await install.install.clock.set(new Date(Date.now() + 60_000));
	const { subject, text } = await install.install.lastEmailTo(email);
	expect(subject).toBe("Reset your password");
	const link = new URL(text.match(/https?:\/\/\S+/)?.[0] ?? "");
	return install.adminUrl(`${link.pathname}${link.search}`);
}

for (const theme of THEMES) {
	describe(`password recovery, ${theme}`, () => {
		test("from the sign-in page: ask for a link, open it, choose a new password", async () => {
			const person = await install.install.createMember({ workspaceId, role: "editor" });
			const page = await install.newPage(theme);

			await page.goto(install.adminUrl("/sign-in"));
			await page.getByRole("link", { name: "Forgot your password?" }).click();
			await page.getByRole("heading", { level: 1, name: "Reset your password" }).waitFor();
			await expectAccessibleScreen(page, `asking for a reset link (${theme})`);

			await page.getByRole("button", { name: "Email me a link" }).click();
			await page.locator("#forgot-password-error").waitFor();
			expect(await page.locator("#forgot-password-error").textContent()).toBe("Enter your email address.");
			await expectAccessibleScreen(page, `asking for a reset link, no address (${theme})`);

			await page.getByLabel("Email").fill(person.account.email);
			await page.keyboard.press("Enter");
			await page.getByRole("heading", { level: 1, name: "Check your email" }).waitFor();
			expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
			expect(await page.locator("main").textContent()).toContain(person.account.email);
			await expectAccessibleScreen(page, `a reset link was asked for (${theme})`);

			await page.goto(await resetLinkFor(person.account.email));
			await page.getByRole("heading", { level: 1, name: "Choose a new password" }).waitFor();
			// The token leaves the address bar once read, so it stays out of the browser's history.
			await page.waitForURL((url) => url.pathname === "/reset-password" && url.search === "");
			await expectAccessibleScreen(page, `choosing a new password (${theme})`);

			if (theme === "light") {
				await page.locator("#reset-password-new").fill("too short");
				await page.getByRole("button", { name: "Change password" }).click();
				await page.locator("#reset-password-error").waitFor();
				expect(await page.locator("#reset-password-error").textContent()).toContain("12 characters");
				await expectAccessibleScreen(page, `choosing a new password, refused (${theme})`);
			}

			await page.locator("#reset-password-new").fill("a new password chosen here");
			await page.keyboard.press("Enter");
			await page.getByRole("heading", { level: 1, name: "Your password is changed" }).waitFor();
			expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
			await expectAccessibleScreen(page, `the password was changed (${theme})`);

			await page.getByRole("link", { name: "Sign in" }).click();
			await page.getByRole("heading", { level: 1, name: /^Sign in/ }).waitFor();
			// Nothing on these pages was refused by the admin's Content Security Policy, or failed.
			expect(pageErrors(page)).toEqual([]);
			await expect(
				install.install.signIn({ email: person.account.email, password: "a new password chosen here" }),
			).resolves.toBeDefined();
		});

		test("a link that doesn't work says so and offers a new one", async () => {
			const page = await install.newPage(theme);
			await page.goto(install.adminUrl("/reset-password?token=not-a-link-anyone-was-sent"));
			await page.getByRole("heading", { level: 1, name: "This reset link doesn't work" }).waitFor();
			await expectAccessibleScreen(page, `a reset link that doesn't work (${theme})`);

			await page.getByRole("link", { name: "Ask for a new link" }).click();
			await page.getByRole("heading", { level: 1, name: "Reset your password" }).waitFor();
		});
	});
}
