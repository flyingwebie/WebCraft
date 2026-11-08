import { afterAll, beforeAll, describe, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";
import { ADMIN_SCREENS } from "./screens.ts";

let install: BrowserInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`admin screens, ${theme}`, () => {
		for (const screen of ADMIN_SCREENS) {
			test(screen.name, async () => {
				const page = await install.newPage(theme);
				if (screen.as === "superadmin") await install.signIn(page, superadmin);
				await page.goto(install.adminUrl(screen.path));
				await page.waitForLoadState("networkidle");

				await expectAccessibleScreen(page, `${screen.name} (${theme})`);
			});
		}
	});
}
