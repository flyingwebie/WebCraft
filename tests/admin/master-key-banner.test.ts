import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, TEST_MASTER_KEY, type TestAccount, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestAccount;

beforeEach(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterEach(async () => {
	await install.close();
});

describe("the Master key banner", () => {
	test("the Superadmin sees it until they confirm the key is stored outside the server", async () => {
		const browser = await install.signIn(superadmin);
		expect((await browser.api.shell.context()).banners.masterKey).toBe(true);

		const status = await browser.api.install.masterKey.confirmStored();

		expect(status).toMatchObject({ stored: true });
		expect((await browser.api.shell.context()).banners.masterKey).toBe(false);
	});

	test("the confirmation is stored: other sessions and later sign-ins don't see the banner", async () => {
		const laptop = await install.signIn(superadmin);
		const phone = await install.signIn(superadmin);

		await laptop.api.install.masterKey.confirmStored();
		await install.restart();

		expect((await phone.api.shell.context()).banners.masterKey).toBe(false);
		const later = await install.signIn(superadmin);
		expect((await later.api.shell.context()).banners.masterKey).toBe(false);
	});

	test("the confirmation is logged with who confirmed and the key's fingerprint, never the key", async () => {
		const browser = await install.signIn(superadmin);
		const { person } = await browser.api.session.current();
		const { fingerprint } = await browser.api.install.masterKey.status();

		await browser.api.install.masterKey.confirmStored();

		const entry = install.logs.find((log) => log.msg.includes("confirmed the Master key is stored outside the server"));
		expect(entry).toMatchObject({ level: "info", personId: person?.id, masterKeyFingerprint: fingerprint });
		expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(install.logs)).not.toContain(TEST_MASTER_KEY);
	});

	test("comes back when the Install starts with another Master key", async () => {
		const browser = await install.signIn(superadmin);
		await browser.api.install.masterKey.confirmStored();

		await install.restart({ masterKey: "a-new-master-key-that-is-long-enough-0123" });

		// A new Master key signs everyone out: session cookies are signed with a key derived from it.
		const again = await install.signIn(superadmin);
		expect((await again.api.shell.context()).banners.masterKey).toBe(true);
	});

	test("people who aren't signed in see no banner and can't confirm", async () => {
		const browser = install.browser();

		expect((await browser.api.shell.context()).banners.masterKey).toBe(false);
		await expect(browser.api.install.masterKey.confirmStored()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
