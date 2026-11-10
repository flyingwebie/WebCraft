// Impersonation in the admin, in light and dark: the dialog that starts it (from a Member's row
// menu, and the Staff screen's button), starting it from the keyboard, the banner on every page while
// it goes on (said to screen readers, with the time left), and Stop. Behaviour is tested at seam 1
// (tests/impersonation); the Audit log screens are lines of screens.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { addAuthenticator, signInWithAuthenticator } from "../harness/two-factor.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount & { secret: string };
let workspaceId: string;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const anna = await local.createStaff({ workspaces: [workspaceId], name: "Agency Anna" });
	const { secret } = await addAuthenticator(local, anna.browser);
	staff = { ...anna.account, secret };
});

afterAll(async () => {
	await install.close();
});

/**
 * Signs the page in as Staff with an authenticator app, without the sign-in page (the web process
 * limits sign-ins per address, and every page here comes from this machine): the test Install signs
 * in at the real time, password then the app's code, so the identity check is fresh, and the page
 * gets the cookie.
 */
async function signInHere(page: Page, account: TestAccount & { secret: string }): Promise<void> {
	const local = install.install;
	// Each sign-in a step later than the one before: an authenticator code works only once.
	await local.clock.set(new Date(Date.now() + ++signIns * 90_000));
	const browser = await signInWithAuthenticator(local, account, account.secret);
	const value = browser.cookies.get("__Secure-webcraft.session_token");
	if (!value) throw new Error(`${account.email} got no session.`);
	await page
		.context()
		.addCookies([
			{ name: "webcraft.session_token", value, domain: "admin.localhost", path: "/", httpOnly: true, sameSite: "Lax" },
		]);
}

let people = 0;
let signIns = 0;

for (const theme of THEMES) {
	describe(`impersonation, ${theme}`, () => {
		test("the start dialog from a Member's row menu, started from the keyboard, then the banner and Stop", async () => {
			const person = await install.install.createMember({ workspaceId, role: "editor", name: `Eve ${++people}` });
			const page = await install.newPage(theme);
			await signInHere(page, staff);

			await page.goto(install.adminUrl(`/workspaces/${workspaceId}/members`));
			await page.waitForLoadState("networkidle");
			await page.getByRole("button", { name: `Actions for ${person.account.name}` }).click();
			await page.getByRole("menuitem", { name: "Impersonate" }).click();
			const dialog = page.getByRole("dialog", { name: `Impersonate ${person.account.name}` });
			await dialog.waitFor();
			await expectNoAxeViolations(page, `the impersonation dialog (${theme})`, ["region"]);

			// From the keyboard: the reason, then Enter starts it.
			await dialog.getByLabel("Reason (optional)").fill("Ticket 4021");
			await page.keyboard.press("Enter");

			const banner = page.getByRole("region", { name: "Impersonation" });
			await banner.waitFor();
			expect(await banner.textContent()).toContain(`You are impersonating ${person.account.name}`);
			expect(await banner.textContent()).toMatch(/60 minutes left|59 minutes left/);
			// Said to screen readers too.
			await page.getByRole("status").filter({ hasText: "You are impersonating" }).waitFor({ state: "attached" });
			await page.waitForLoadState("networkidle");
			await expectAccessibleScreen(page, `the admin while impersonating, with the banner (${theme})`);

			// On a Site's pages, no Staging nor Edit on site while impersonating.
			await page.goto(install.adminUrl(`/sites/${siteId}`));
			await banner.waitFor();
			expect(await page.getByRole("button", { name: "Staging" }).count()).toBe(0);

			// Stop from the keyboard: back where it started, as Staff again.
			await banner.getByRole("button", { name: "Stop impersonating" }).focus();
			await page.keyboard.press("Enter");
			await page.getByText("You are yourself again.").waitFor();
			await banner.waitFor({ state: "detached" });
			await page.waitForURL(`**/workspaces/${workspaceId}/members`);
		});

		test("the Staff screen's Impersonate button opens the same dialog (the Superadmin)", async () => {
			const page = await install.newPage(theme);
			const local = install.install;
			await local.clock.set(new Date());
			const admin = await local.superadmin();
			const value = admin.cookies.get("__Secure-webcraft.session_token");
			if (!value) throw new Error("The Superadmin got no session.");
			await page.context().addCookies([
				{
					name: "webcraft.session_token",
					value,
					domain: "admin.localhost",
					path: "/",
					httpOnly: true,
					sameSite: "Lax",
				},
			]);

			await page.goto(install.adminUrl("/staff"));
			await page.waitForLoadState("networkidle");
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Impersonate Agency Anna" }),
				"dialog",
				`impersonating a Staff member (${theme})`,
			);
		});
	});
}
