// Offboarding in the admin, in light and dark: the Superadmin ends a Staff member's role and
// deactivates or reactivates an account from the Staff screen, and deactivates a Member's account
// from the Members screen. Behaviour is tested at seam 1 (tests/tenancy/offboarding.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let workspaceId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`offboarding, ${theme}`, () => {
		test("the Staff screen: deactivate an account, reactivate it, then remove the person from Staff", async () => {
			const name = `Lee Leaver ${theme}`;
			const leaver = await install.install.createStaff({ workspaces: [workspaceId], name });
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/staff"));
			const row = page.getByRole("row").filter({ hasText: leaver.account.email });
			await row.waitFor();

			const deactivate = page.getByRole("button", { name: `Deactivate account of ${name}` });
			await expectOverlayUsable(page, deactivate, "dialog", `deactivating an account (${theme})`);
			await deactivate.click();
			await page.getByRole("dialog").getByRole("button", { name: "Deactivate account" }).click();
			await row.getByText("Deactivated").waitFor();
			await page.getByRole("dialog").waitFor({ state: "hidden" });
			await expectAccessibleScreen(page, `Staff, with a deactivated account (${theme})`);
			await expect(install.install.signIn(leaver.account)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

			const reactivate = page.getByRole("button", { name: `Reactivate account of ${name}` });
			await expectOverlayUsable(page, reactivate, "dialog", `reactivating an account (${theme})`);
			await reactivate.click();
			await page.getByRole("dialog").getByRole("button", { name: "Reactivate account" }).click();
			await row.getByText("Deactivated").waitFor({ state: "detached" });
			// The dialog closes and hands focus back to its button before the next one opens.
			await page.getByRole("dialog").waitFor({ state: "hidden" });
			await page.waitForFunction(() => document.activeElement?.tagName === "BUTTON");

			const remove = page.getByRole("button", { name: `Remove from Staff: ${name}` });
			await expectOverlayUsable(page, remove, "dialog", `removing someone from Staff (${theme})`);
			await remove.click();
			await page.getByRole("dialog").getByRole("button", { name: "Remove from Staff" }).click();
			await row.waitFor({ state: "detached" });
			expect(pageErrors(page)).toEqual([]);
			// The screen as it opens next, once the "no longer Staff" notice has gone.
			await page.reload();
			await page.getByRole("heading", { level: 1, name: "Staff" }).waitFor();
			await expectAccessibleScreen(page, `Staff, after someone was removed (${theme})`);
			expect(pageErrors(page)).toEqual([]);
		});

		test("the Members screen: the Superadmin deactivates a Member's account from the row menu", async () => {
			const name = `Mo Member ${theme}`;
			const member = await install.install.createMember({ workspaceId, role: "editor", name });
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/workspaces/${workspaceId}/members`));
			const row = page.getByRole("row").filter({ hasText: member.account.email });
			await row.waitFor();

			const menu = page.getByRole("button", { name: `Actions for ${name}` });
			await expectOverlayUsable(page, menu, "menu", `a Member's actions, with Deactivate account (${theme})`);
			await menu.click();
			await page.getByRole("menuitem", { name: "Deactivate account" }).click();
			await page.getByRole("dialog").waitFor();
			// A dialog sits outside the page's landmarks, as dialogs do: the landmark rule is skipped.
			await expectNoAxeViolations(page, `deactivating a Member's account (${theme})`, ["region"]);
			await page.getByRole("dialog").getByRole("button", { name: "Deactivate account" }).click();
			await row.getByText("Deactivated").waitFor();
			await expectAccessibleScreen(page, `Members, with a deactivated account (${theme})`);

			await menu.click();
			await page.getByRole("menuitem", { name: "Reactivate account" }).waitFor();
			expect(pageErrors(page)).toEqual([]);
		});
	});
}
