import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, FAKE_SMTP_RESPONSE, type TestAccount, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

beforeEach(async () => {
	install.mail.clear();
	install.mail.accept();
	// Each test's emails are newer than the last test's, so "newest first" picks them.
	await install.clock.advance(1_000);
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
			sitePrivateServers: false,
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
			sitePrivateServers: false,
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

	test("each change is recorded in the Audit log, with what changed but never the password", async () => {
		const browser = await install.signIn(superadmin);

		await browser.api.install.smtp.update({ ...SMTP, password: "an audited smtp password" });
		await browser.api.install.smtp.update({ ...SMTP, port: 465, security: "tls" });
		await browser.api.install.smtp.update({ ...SMTP, password: null });

		const admin = await install.superadmin();
		const { entries } = await admin.api.audit.list({ limit: 3 });
		const settings = { host: SMTP.host, username: SMTP.username, fromAddress: SMTP.fromAddress, replyTo: null };
		expect(entries).toMatchObject([
			{ action: "installSmtp.change", details: { ...settings, port: 587, security: "starttls", password: "removed" } },
			{ action: "installSmtp.change", details: { ...settings, port: 465, security: "tls", password: "kept" } },
			{ action: "installSmtp.change", details: { ...settings, port: 587, security: "starttls", password: "replaced" } },
		]);
		const personId = (await browser.api.session.current()).person?.id;
		expect(entries.every((entry) => entry.personId === personId && entry.via.kind === "admin")).toBe(true);
		expect(JSON.stringify(entries)).not.toContain("an audited smtp password");
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

describe("Send test email", () => {
	test("sends at once through the settings in the form, before they are saved, and answers the server's reply", async () => {
		const browser = await install.signIn(superadmin);
		const before = await browser.api.install.smtp.get();

		const result = await browser.api.install.smtp.sendTest({
			to: "ops@agency.example",
			settings: { ...SMTP, host: "smtp.new-provider.example", port: 465, security: "tls" },
			password: "a typed password 1234",
		});

		expect(result).toEqual({ status: "sent", response: FAKE_SMTP_RESPONSE });
		expect(install.mail.sent).toEqual([
			expect.objectContaining({
				to: "ops@agency.example",
				from: { name: "WebCraft", address: SMTP.fromAddress },
				subject: "Test email from WebCraft",
				smtp: {
					host: "smtp.new-provider.example",
					port: 465,
					security: "tls",
					username: SMTP.username,
					password: "a typed password 1234",
				},
			}),
		]);
		expect(await browser.api.install.smtp.get()).toEqual(before);
		expect((await browser.api.install.emailLog.list({})).lines[0]).toMatchObject({
			type: "smtp-test",
			recipient: "ops@agency.example",
			subject: "Test email from WebCraft",
			smtp: "install",
			status: "sent",
			attempts: 1,
			lastResponse: FAKE_SMTP_RESPONSE,
			related: { kind: "install-smtp", id: "install" },
		});
	});

	test("without a new password it uses the stored one", async () => {
		const browser = await install.signIn(superadmin);
		await browser.api.install.smtp.update({ ...SMTP, password: "the stored password 5678" });

		await browser.api.install.smtp.sendTest({ to: "ops@agency.example", settings: SMTP });

		expect(install.mail.sent[0]?.smtp.password).toBe("the stored password 5678");
	});

	test("the stored password goes only to the server it was saved for: another needs its password typed", async () => {
		const browser = await install.signIn(superadmin);
		await browser.api.install.smtp.update({ ...SMTP, password: "the stored password 5678" });

		for (const settings of [
			{ ...SMTP, host: "smtp.elsewhere.example" },
			{ ...SMTP, port: 2525 },
			{ ...SMTP, username: "someone-else" },
		]) {
			await expect(browser.api.install.smtp.sendTest({ to: "ops@agency.example", settings })).rejects.toMatchObject({
				code: "SMTP_PASSWORD_NEEDED",
				status: 400,
			});
		}
		expect(install.mail.attempts).toEqual([]);
	});

	test("a test the server refuses answers its reply, and doesn't count towards Failing", async () => {
		const browser = await install.signIn(superadmin);
		await browser.api.install.smtp.update({ ...SMTP, password: "the stored password 5678" });
		install.mail.fail("535 5.7.8 Authentication failed");

		for (let attempt = 0; attempt < 3; attempt++) {
			expect(await browser.api.install.smtp.sendTest({ to: "ops@agency.example", settings: SMTP })).toEqual({
				status: "failed",
				response: "535 5.7.8 Authentication failed",
			});
		}

		expect((await browser.api.install.smtp.get()).health).toMatchObject({ state: "working", failuresInARow: 0 });
		expect((await browser.api.install.emailLog.list({ limit: 1 })).lines[0]).toMatchObject({
			type: "smtp-test",
			status: "failed",
			lastResponse: "535 5.7.8 Authentication failed",
		});
	});

	test("is written in the Superadmin's Admin language", async () => {
		const browser = await install.signIn(superadmin);
		await browser.api.me.updatePreferences({ adminLanguage: "it" });

		await browser.api.install.smtp.sendTest({ to: "ops@agency.example", settings: SMTP });

		expect(install.mail.sent[0]?.subject).toBe("Email di prova da WebCraft");
		await browser.api.me.updatePreferences({ adminLanguage: null });
	});

	test("refuses a recipient that isn't an email address, and people who aren't signed in", async () => {
		const browser = await install.signIn(superadmin);

		await expect(browser.api.install.smtp.sendTest({ to: "not an address", settings: SMTP })).rejects.toMatchObject({
			code: "EMAIL_INVALID",
		});
		await expect(
			install.browser().api.install.smtp.sendTest({ to: "ops@agency.example", settings: SMTP }),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(install.mail.attempts).toEqual([]);
	});
});
