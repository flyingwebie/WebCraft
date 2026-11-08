// The parts of the admin shell that open over a page (menus, dialogs) and the theme switch.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

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
	describe(`admin shell, ${theme}`, () => {
		test("the context switcher opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /Switch Workspace or Site/ }),
				"menu",
				`context switcher (${theme})`,
			);
		});

		test("the account menu opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /Open the account menu/ }),
				"menu",
				`account menu (${theme})`,
			);
		});

		test("the Master key help opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "How to back up" }),
				"dialog",
				`Master key help (${theme})`,
			);
		});
	});
}

describe("the light/dark switch", () => {
	test("is a toggle button that switches the admin to dark and back", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, superadmin);
		const toggle = page.getByRole("button", { name: "Dark theme" });
		expect(await toggle.getAttribute("aria-pressed")).toBe("false");

		await toggle.click();
		await page.waitForFunction(() => document.documentElement.className === "dark");

		expect(await toggle.getAttribute("aria-pressed")).toBe("true");
		await expectAccessibleScreen(page, "Install › Overview (switched to dark)");

		await toggle.click();
		await page.waitForFunction(() => document.documentElement.className === "light");
		expect(await toggle.getAttribute("aria-pressed")).toBe("false");
	});
});
