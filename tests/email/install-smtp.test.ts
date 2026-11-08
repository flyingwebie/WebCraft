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

const SMTP = {
	host: "smtp.agency.example",
	port: 587,
	security: "starttls",
	username: "mailer@agency.example",
	fromAddress: "noreply@agency.example",
	replyTo: null,
} as const;

describe("Install SMTP", () => {
	test("isn't set on a fresh Install", async () => {
		const browser = await install.signIn(superadmin);

		expect(await browser.api.install.smtp.get()).toEqual({
			settings: null,
			health: { state: "not-set", failuresInARow: 0, failingSince: null, lastResponse: null },
		});
	});

	test("the Superadmin sets it; the password is a secret that shows only as set, with its last 4 characters", async () => {
		const browser = await install.signIn(superadmin);

		const saved = await browser.api.install.smtp.update({ ...SMTP, password: "a long smtp password 7d2q" });

		const expected = {
			settings: {
				...SMTP,
				password: { set: true, lastFour: "7d2q", updatedAt: install.clock.now() },
				updatedAt: install.clock.now(),
			},
			health: { state: "working" as const, failuresInARow: 0, failingSince: null, lastResponse: null },
		};
		expect(saved).toEqual(expected);
		expect(await browser.api.install.smtp.get()).toEqual(expected);
		expect(JSON.stringify(saved)).not.toContain("a long smtp password");
		expect(await install.secrets.describe({ owner: { kind: "install" }, name: "smtp.password" })).toMatchObject({
			set: true,
			lastFour: "7d2q",
		});
	});

	test("saving without a password keeps the stored one; a new password replaces it; null removes it", async () => {
		const browser = await install.signIn(superadmin);
		await browser.api.install.smtp.update({ ...SMTP, password: "the first password abcd" });

		const kept = await browser.api.install.smtp.update({ ...SMTP, host: "mail.agency.example" });
		expect(kept.settings).toMatchObject({ host: "mail.agency.example", password: { set: true, lastFour: "abcd" } });

		const replaced = await browser.api.install.smtp.update({ ...SMTP, password: "the second password wxyz" });
		expect(replaced.settings?.password).toMatchObject({ set: true, lastFour: "wxyz" });

		const removed = await browser.api.install.smtp.update({ ...SMTP, username: null, password: null });
		expect(removed.settings).toMatchObject({ username: null, password: { set: false } });
	});

	test("addresses, host and port are checked", async () => {
		const browser = await install.signIn(superadmin);

		await expect(browser.api.install.smtp.update({ ...SMTP, fromAddress: "not an address" })).rejects.toMatchObject({
			code: "EMAIL_INVALID",
		});
		await expect(browser.api.install.smtp.update({ ...SMTP, replyTo: "nope" })).rejects.toMatchObject({
			code: "EMAIL_INVALID",
		});
		await expect(browser.api.install.smtp.update({ ...SMTP, port: 0 })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(browser.api.install.smtp.update({ ...SMTP, host: "smtp example com" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	test("people who aren't signed in can't read or change it", async () => {
		const browser = install.browser();

		await expect(browser.api.install.smtp.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(browser.api.install.smtp.update({ ...SMTP, password: "x".repeat(20) })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});
