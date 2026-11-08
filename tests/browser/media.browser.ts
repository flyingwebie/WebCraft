// The Media library's dialogs and menus from the keyboard: New folder, and a folder's menu.
import { afterAll, beforeAll, describe, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const admin = await install.install.superadmin();
	await admin.api.media.folders.create({ siteId, name: "Weddings" });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Media library, ${theme}`, () => {
		test("the New folder dialog opens and closes from the keyboard, and shows a missing name accessibly", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/media`));
			await page.waitForLoadState("networkidle");
			const trigger = page.getByRole("button", { name: "New folder" });

			await expectOverlayUsable(page, trigger, "dialog", `New folder (${theme})`);

			await trigger.click();
			await page.getByRole("button", { name: "Create folder" }).click();
			await page.getByText("Give the folder a name.").waitFor();
			await expectNoAxeViolations(page, `New folder, no name (${theme})`, ["region"]);
		});

		test("a folder's menu opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/media`));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Weddings" }),
				"menu",
				`Folder menu (${theme})`,
			);
		});
	});
}
