import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

beforeEach(async () => {
	install = await createTestInstall();
});

afterEach(async () => {
	await install.close();
});

describe("Admin language", () => {
	test("a fresh Install's admin is in English, written left to right", async () => {
		expect((await install.browser().api.shell.context()).language).toEqual({ code: "en", dir: "ltr" });
	});

	test("the language chosen in the setup wizard becomes the Install's default and the Superadmin's", async () => {
		const superadmin = install.browser();
		await superadmin.api.setup.claim({
			token: install.setupToken() ?? "",
			name: "Giulia Romano",
			email: "giulia@agency.example",
			password: "una password abbastanza lunga",
			adminLanguage: "it",
		});

		expect((await superadmin.api.shell.context()).language.code).toBe("it");
		expect((await install.browser().api.shell.context()).language.code).toBe("it");
	});

	test("each person picks their own, starting from the Install's default", async () => {
		const account = await install.createSuperadmin({ adminLanguage: "en" });
		const browser = await install.signIn(account);
		await browser.api.me.updatePreferences({ adminLanguage: null });

		await browser.api.install.settings.update({ defaultAdminLanguage: "it" });
		expect((await browser.api.shell.context()).language.code).toBe("it");

		await browser.api.me.updatePreferences({ adminLanguage: "en" });
		expect((await browser.api.shell.context()).language.code).toBe("en");
		expect((await install.browser().api.shell.context()).language.code).toBe("it");
	});

	test("a language the admin doesn't ship is refused", async () => {
		const browser = await install.signIn(await install.createSuperadmin());

		// @ts-expect-error The typed client already refuses it; a raw call must be refused too.
		const picking = browser.api.me.updatePreferences({ adminLanguage: "xx" });

		await expect(picking).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("light and dark", () => {
	test("each person's choice is kept, and the admin follows the device until they choose", async () => {
		const browser = await install.signIn(await install.createSuperadmin());
		expect((await browser.api.shell.context()).theme).toBe("system");

		await browser.api.me.updatePreferences({ adminTheme: "dark" });

		expect((await browser.api.shell.context()).theme).toBe("dark");
		expect((await install.browser().api.shell.context()).theme).toBe("system");
	});
});
