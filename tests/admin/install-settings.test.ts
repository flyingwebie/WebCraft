import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

describe("Install settings › General", () => {
	test("the Superadmin names the Install, and the admin shows the name", async () => {
		const browser = await install.signIn(superadmin);
		expect(await browser.api.install.settings.get()).toEqual({ name: null, defaultAdminLanguage: "en" });

		await browser.api.install.settings.update({ name: "  Northwind Studio " });

		expect(await browser.api.install.settings.get()).toEqual({ name: "Northwind Studio", defaultAdminLanguage: "en" });
		expect((await install.browser().api.shell.context()).install).toEqual({
			name: "Northwind Studio",
			defaultAdminLanguage: "en",
		});
	});

	test("clearing the name shows no name again", async () => {
		const browser = await install.signIn(superadmin);

		await browser.api.install.settings.update({ name: "" });

		expect((await browser.api.install.settings.get()).name).toBeNull();
	});

	test("people who aren't signed in can't read or change them", async () => {
		const browser = install.browser();

		await expect(browser.api.install.settings.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(browser.api.install.settings.update({ name: "Mallory" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});

describe("the admin shell", () => {
	test("shows who is signed in, with their role", async () => {
		const browser = await install.signIn(superadmin);

		expect(await browser.api.shell.context()).toMatchObject({
			setup: { stage: "done" },
			person: { name: superadmin.name, email: superadmin.email, installRole: "superadmin" },
		});
	});

	test("shows nobody to people who aren't signed in", async () => {
		expect(await install.browser().api.shell.context()).toMatchObject({ person: null, banners: { masterKey: false } });
	});
});
