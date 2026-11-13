// Your account › API tokens in a real browser: the list (an active token, one read-only for chosen
// Sites, one revoked), creating a token from the keyboard (a Sensitive action) and the token shown
// once, and revoking one, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken } from "../harness/api-tokens.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	const admin = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	const bakery = await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" });
	await local.createSite(workspaceId, { name: "Acme Catering", slug: "catering" });
	await createApiToken(admin, { workspaceId, name: "Deploy script" });
	await createApiToken(admin, {
		workspaceId,
		name: "Analytics export",
		sites: [bakery.id],
		readOnly: true,
		lifetimeDays: 365,
	});
	const { tokenId } = await createApiToken(admin, { workspaceId, name: "Old laptop", lifetimeDays: null });
	await admin.api.apiTokens.revoke({ tokenId });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Your account › API tokens, ${theme}`, () => {
		const open = async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/account/api-tokens"));
			await page.waitForLoadState("networkidle");
			return page;
		};

		test("the tokens: active, read-only for one Site, and revoked", async () => {
			const page = await open();
			await page.getByText("Analytics export").waitFor();
			await page.getByText("Revoked", { exact: true }).waitFor();

			await expectAccessibleScreen(page, `API tokens (${theme})`);
		});

		test("the create dialog opens and closes from the keyboard", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Create token" }),
				"dialog",
				`API tokens › Create (${theme})`,
			);
		});

		test("a token made from the keyboard is shown once, to copy", async () => {
			const page = await open();
			await page.getByRole("button", { name: "Create token" }).focus();
			await page.keyboard.press("Enter");
			const dialog = page.getByRole("dialog", { name: "Create an API token" });
			await dialog.waitFor();
			await dialog.getByLabel("Name").fill(`Build server ${theme}`);
			await dialog.getByRole("radio", { name: "Only the Sites I choose" }).check();
			await dialog.getByRole("checkbox", { name: "Acme Catering" }).check();
			await dialog.getByRole("radio", { name: "Read only" }).check();
			await dialog.getByLabel("Expires").selectOption("30");
			await dialog.getByRole("button", { name: "Create token" }).focus();
			await page.keyboard.press("Enter");

			const shown = page.getByRole("dialog", { name: `Build server ${theme} is ready` });
			await shown.waitFor();
			expect(await shown.getByLabel("Token").inputValue()).toMatch(/^webcraft_/);
			await expectNoAxeViolations(page, `API tokens › the token shown (${theme})`, ["region"]);
			await shown.getByRole("button", { name: "Done" }).click();
			await shown.waitFor({ state: "hidden" });
			await page.getByText(`Build server ${theme}`).waitFor();
		});

		test("a name left out is said beside its field", async () => {
			const page = await open();
			await page.getByRole("button", { name: "Create token" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("button", { name: "Create token" }).click();
			await dialog.getByText("Give the token a name.").waitFor();

			await expectNoAxeViolations(page, `API tokens › a name left out (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
		});

		test("revoking a token asks first", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Revoke Deploy script" }),
				"dialog",
				`API tokens › Revoke (${theme})`,
			);
		});
	});
}
