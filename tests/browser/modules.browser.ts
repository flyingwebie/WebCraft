// The Module screens' overlays: the consent screen, the Module log and removing a Module's data,
// each opened from the keyboard, checked with axe, and closed with Escape. The screens themselves
// are in screens.ts.
import { afterAll, beforeAll, describe, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	const workspace = await local.createWorkspace("Acme Ltd");
	siteId = (await local.createSite(workspace.id, { name: "Acme Bakery", slug: "bakery" })).id;
	const admin = await local.superadmin();
	await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Module screens, ${theme}`, () => {
		test("the consent screen of a Module waiting for approval", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/settings/modules"));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Review and approve Sample board" }),
				"dialog",
				`consent screen (${theme})`,
			);
		});

		test("the Module log", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/settings/modules"));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Module log of Sample notes" }),
				"dialog",
				`Module log (${theme})`,
			);
		});

		test("removing a Module's data from a Site", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/modules`));
			await page.waitForLoadState("networkidle");
			await expectAccessibleScreen(page, `Site › Modules as the Superadmin (${theme})`);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Remove data of Sample notes" }),
				"dialog",
				`removing a Module's data (${theme})`,
			);
		});
	});
}
