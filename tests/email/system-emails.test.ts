import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestAccount;
let admin: TestBrowser;
let superadminId: string;

const SMTP = {
	host: "smtp.agency.example",
	port: 587,
	security: "starttls",
	username: "mailer@agency.example",
	fromAddress: "noreply@agency.example",
	replyTo: "help@agency.example",
} as const;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin({ name: "Sam Superadmin" });
	admin = await install.signIn(superadmin);
	superadminId = (await admin.api.session.current()).person?.id ?? "";
	await admin.api.install.smtp.update({ ...SMTP, password: "the smtp password 9x8y" });
});

afterAll(async () => {
	await install.close();
});

beforeEach(async () => {
	install.mail.clear();
	install.mail.accept();
});

describe("a System email", () => {
	test("is queued, then the worker sends it through the Install SMTP with the stored password", async () => {
		const report = await install.sendSystemEmail({
			type: "password-reset",
			to: { personId: superadminId },
			data: { resetPath: "/reset-password?token=abc123", expiresInMinutes: 30 },
		});

		expect(report).toEqual([{ recipient: superadmin.email, status: "queued", emailId: expect.any(String) }]);
		expect(install.mail.sent).toEqual([]);

		const drained = await install.drainJobs();

		expect(drained.failed).toEqual([]);
		expect(install.mail.sent).toHaveLength(1);
		const [sent] = install.mail.sent;
		expect(sent).toMatchObject({
			from: { name: "WebCraft", address: "noreply@agency.example" },
			to: superadmin.email,
			replyTo: "help@agency.example",
			subject: "Reset your password",
			headers: { "Auto-Submitted": "auto-generated" },
			smtp: {
				host: "smtp.agency.example",
				port: 587,
				security: "starttls",
				username: "mailer@agency.example",
				password: "the smtp password 9x8y",
			},
		});
		expect(sent?.text).toContain("https://admin.test/reset-password?token=abc123");
		expect(sent?.html).toContain('href="https://admin.test/reset-password?token=abc123"');
	});

	test("goes to a bare address, in the language given, when the recipient has no account yet", async () => {
		await install.sendSystemEmail({
			type: "staff-invite",
			to: { email: "Nuovo.Collega@Agency.example", language: "it" },
			data: { inviterName: "Sam Superadmin", acceptPath: "/invites/xyz", expiresInDays: 7 },
		});
		await install.drainJobs();

		expect(install.mail.sent.map(({ to, subject }) => ({ to, subject }))).toEqual([
			{ to: "nuovo.collega@agency.example", subject: "Sam Superadmin ti ha invitato su WebCraft" },
		]);
	});

	test("refuses data that doesn't fit its type, such as a link out of the admin", async () => {
		const sending = install.sendSystemEmail({
			type: "password-reset",
			to: { personId: superadminId },
			// Links in System emails only lead into the admin: data holds admin paths, never full URLs.
			data: { resetPath: "https://elsewhere.example/steal", expiresInMinutes: 30 },
		});

		await expect(sending).rejects.toThrow();
		await install.drainJobs();
		expect(install.mail.sent).toEqual([]);
	});
});
