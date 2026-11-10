// Two-factor authentication in the admin, in light and dark: the second sign-in step, Your
// account's settings (an authenticator app with its QR code and key as text, backup codes shown and
// downloaded, passkeys through a virtual authenticator), the screen a person who must set it up
// lands on, the reminder, and the reset dialogs. Behaviour is tested at seam 1 (tests/auth).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { addAuthenticator, confirmIfAsked, totpCode } from "../harness/two-factor.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let workspaceId: string;
let strictWorkspaceId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	strictWorkspaceId = (await local.createWorkspace("Strict Ltd")).id;
	// The Owner of Strict Ltd requires two-factor authentication of its Members.
	const owner = await local.createMember({ workspaceId: strictWorkspaceId, role: "owner", name: "Sarah Murphy" });
	await addAuthenticator(local, owner.browser);
	await confirmIfAsked(owner.browser, owner.account.password, () =>
		owner.browser.api.members.requireTwoFactor({ workspaceId: strictWorkspaceId, required: true }),
	);
});

afterAll(async () => {
	await install.close();
});

/**
 * Signs the page in as `account` without the sign-in page (the web process limits sign-ins per
 * address, and every page here comes from this machine): the test Install signs in at the real time,
 * so the identity check is fresh, and the page gets the cookie.
 */
async function signInHere(page: Page, account: TestAccount): Promise<void> {
	const local = install.install;
	await local.clock.set(new Date());
	const browser = await local.signIn(account);
	// The test Install's admin is on https, so its cookie carries the `__Secure-` prefix; the web
	// process here is on plain http, where the same signed value goes without it.
	const value = browser.cookies.get("__Secure-webcraft.session_token");
	if (!value) throw new Error(`${account.email} got no session.`);
	await page
		.context()
		.addCookies([
			{ name: "webcraft.session_token", value, domain: "admin.localhost", path: "/", httpOnly: true, sameSite: "Lax" },
		]);
}

/** The key the authenticator dialog shows as text, without its spaces. */
async function keyShown(page: Page): Promise<string> {
	return ((await page.locator("#authenticator-key").textContent()) ?? "").replace(/\s/g, "");
}

let people = 0;

async function member(workspace = workspaceId) {
	const name = `Person ${++people}`;
	return install.install.createMember({ workspaceId: workspace, role: "editor", name });
}

for (const theme of THEMES) {
	describe(`two-factor authentication, ${theme}`, () => {
		test("the second sign-in step: a code from the app, a refused code, and a backup code instead", async () => {
			const person = await member();
			const { secret } = await addAuthenticator(install.install, person.browser);
			const page = await install.newPage(theme);

			await page.goto(install.adminUrl("/sign-in"));
			await page.locator("#sign-in-email").fill(person.account.email);
			await page.locator("#sign-in-password").fill(person.account.password);
			await page.locator("form button[type=submit]").click();
			await page.getByRole("heading", { level: 1, name: "Two-step verification" }).waitFor();
			expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
			await expectAccessibleScreen(page, `second sign-in step (${theme})`);

			await page.locator("#sign-in-code").fill("000000");
			await page.getByRole("button", { name: "Verify" }).click();
			await page.locator("#sign-in-code-error").waitFor();
			expect(await page.locator("#sign-in-code-error").textContent()).toContain(
				"That code is wrong or was already used.",
			);
			await expectAccessibleScreen(page, `second sign-in step, a refused code (${theme})`);

			await page.getByRole("button", { name: "Use a backup code instead" }).click();
			await page.getByLabel("Backup code").waitFor();
			await expectAccessibleScreen(page, `second sign-in step, a backup code (${theme})`);

			await page.getByRole("button", { name: "Use your authenticator app instead" }).click();
			// The real clock's next step: the test Install used the step it was set up in.
			await page.locator("#sign-in-code").fill(totpCode(secret, new Date(), 1));
			await page.getByRole("button", { name: "Verify" }).click();
			await page.waitForURL((url) => url.pathname === "/");
		});

		test("Your account: adding an authenticator app with its QR code and key, then the backup codes", async () => {
			const person = await member();
			const page = await install.newPage(theme);
			await signInHere(page, person.account);
			await page.goto(install.adminUrl("/account"));
			await page.waitForLoadState("networkidle");
			await expectAccessibleScreen(page, `Your account, two-factor authentication off (${theme})`);

			const add = page.getByRole("button", { name: "Add an authenticator app" });
			await expectOverlayUsable(page, add, "dialog", `adding an authenticator app (${theme})`);

			await add.click();
			await page.getByRole("img", { name: /QR code adding/ }).waitFor();
			const key = await keyShown(page);
			expect(key).toMatch(/^[A-Z2-7]{32}$/);
			await page.locator("#authenticator-code").fill("000000");
			await page.getByRole("button", { name: "Add app" }).click();
			await page.locator("#authenticator-code-error").waitFor();
			await expectNoAxeViolations(page, `adding an authenticator app, a refused code (${theme})`, ["region"]);

			await page.locator("#authenticator-code").fill(totpCode(key, new Date()));
			await page.getByRole("button", { name: "Add app" }).click();
			await page.getByRole("heading", { name: "Save your backup codes" }).waitFor();
			await expectNoAxeViolations(page, `backup codes shown once (${theme})`, ["region"]);
			const codes = await page.getByRole("list", { name: "Your backup codes" }).getByRole("listitem").allTextContents();
			expect(codes).toHaveLength(10);

			const [download] = await Promise.all([
				page.waitForEvent("download"),
				page.getByRole("button", { name: "Download" }).click(),
			]);
			expect(download.suggestedFilename()).toBe("webcraft-backup-codes.txt");
			const saved = await readFile((await download.path()) ?? "", "utf8");
			for (const code of codes) expect(saved).toContain(code);

			await page.getByRole("button", { name: "I've saved them" }).click();
			await page
				.getByText(/Added /)
				.first()
				.waitFor();
			await expectAccessibleScreen(page, `Your account, with an authenticator app (${theme})`);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Make new backup codes" }),
				"dialog",
				`making new backup codes (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Remove the authenticator app" }),
				"dialog",
				`removing the authenticator app (${theme})`,
			);
		});

		test("Your account: adding a passkey through the device, and signing in with it", async () => {
			const person = await member();
			const page = await install.newPage(theme);
			const device = await page.context().newCDPSession(page);
			await device.send("WebAuthn.enable");
			await device.send("WebAuthn.addVirtualAuthenticator", {
				options: {
					protocol: "ctap2",
					transport: "internal",
					hasResidentKey: true,
					hasUserVerification: true,
					isUserVerified: true,
					automaticPresenceSimulation: true,
				},
			});
			await signInHere(page, person.account);
			await page.goto(install.adminUrl("/account"));
			await page.waitForLoadState("networkidle");

			const add = page.getByRole("button", { name: "Add a passkey" });
			await expectOverlayUsable(page, add, "dialog", `naming a passkey (${theme})`);
			await add.click();
			await page.getByLabel("Name").fill("Work laptop");
			await page.getByRole("button", { name: "Continue" }).click();
			await page.getByRole("heading", { name: "Save your backup codes" }).waitFor();
			await page.getByRole("button", { name: "I've saved them" }).click();
			await page.getByText("Work laptop").waitFor();
			await expectAccessibleScreen(page, `Your account, with a passkey (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Remove the passkey Work laptop" }),
				"dialog",
				`removing a passkey (${theme})`,
			);

			// Signing in with the passkey alone, once: the web process limits sign-ins from this machine.
			if (theme !== "light") return;
			await page.context().clearCookies();
			await page.goto(install.adminUrl("/sign-in"));
			await page.getByRole("button", { name: "Sign in with a passkey" }).click();
			await page.waitForURL((url) => url.pathname === "/");
		});

		test("a person who must use it lands on its setup, and nothing else, until it is set up", async () => {
			const person = await member(strictWorkspaceId);
			const page = await install.newPage(theme);
			await signInHere(page, person.account);

			await page.goto(install.adminUrl(`/workspaces/${strictWorkspaceId}`));
			await page.waitForURL((url) => url.pathname === "/two-factor");
			await page.getByRole("heading", { level: 1, name: "Set up two-factor authentication to continue" }).waitFor();
			await page.waitForLoadState("networkidle");
			await expectAccessibleScreen(page, `two-factor authentication required (${theme})`);

			await page.getByRole("button", { name: "Set up an authenticator app" }).click();
			await page.getByRole("img", { name: /QR code adding/ }).waitFor();
			await expectNoAxeViolations(page, `two-factor authentication required, adding an app (${theme})`, ["region"]);
			await page.locator("#authenticator-code").fill(totpCode(await keyShown(page), new Date()));
			await page.getByRole("button", { name: "Add app" }).click();
			await page.getByRole("button", { name: "I've saved them" }).click();
			await page.waitForURL((url) => url.pathname === `/workspaces/${strictWorkspaceId}`);
		});

		test("the reminder shows to people without it, and Remind me later puts it off", async () => {
			const person = await member();
			const page = await install.newPage(theme);
			await signInHere(page, person.account);
			await page.goto(install.adminUrl("/"));
			await page.waitForLoadState("networkidle");
			const reminder = page.getByRole("region", { name: "Add two-factor authentication to your account" });
			await reminder.waitFor();
			await expectAccessibleScreen(page, `the reminder (${theme})`);

			await page.getByRole("button", { name: "Remind me later" }).click();
			await reminder.waitFor({ state: "hidden" });
		});

		test("the reset dialogs: a Member's from the Members screen, a Staff member's from the Staff screen", async () => {
			const person = await member();
			await addAuthenticator(install.install, person.browser);
			const staff = await install.install.createStaff({ workspaces: [workspaceId], name: `Staff ${theme}` });
			await addAuthenticator(install.install, staff.browser);
			const page = await install.newPage(theme);
			await signInHere(page, superadmin);

			await page.goto(install.adminUrl(`/workspaces/${workspaceId}/members`));
			await page.waitForLoadState("networkidle");
			await expectAccessibleScreen(page, `Members with their two-factor authentication (${theme})`);
			await page.getByRole("button", { name: `Actions for ${person.account.name}` }).click();
			await page.getByRole("menuitem", { name: "Reset two-factor authentication" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.waitFor();
			await expectNoAxeViolations(page, `resetting a Member's two-factor authentication (${theme})`, ["region"]);
			await dialog.getByRole("button", { name: "Reset" }).click();
			await page.getByText(`${person.account.name}'s two-factor authentication was reset.`).waitFor();

			await page.goto(install.adminUrl("/staff"));
			await page.waitForLoadState("networkidle");
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: `Reset two-factor authentication of Staff ${theme}` }),
				"dialog",
				`resetting a Staff member's two-factor authentication (${theme})`,
			);
		});
	});
}
