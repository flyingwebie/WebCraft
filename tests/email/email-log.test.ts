import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	createTestInstall,
	FAKE_SMTP_RESPONSE,
	type TestAccount,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";

const DAY = 24 * 60 * 60 * 1000;

const SMTP = {
	host: "smtp.agency.example",
	port: 587,
	security: "starttls",
	username: "mailer@agency.example",
	fromAddress: "noreply@agency.example",
	replyTo: null,
} as const;

let install: TestInstall;
let superadmin: TestAccount;
let admin: TestBrowser;
let superadminId: string;

beforeEach(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
	admin = await install.signIn(superadmin);
	superadminId = (await admin.api.session.current()).person?.id ?? "";
});

afterEach(async () => {
	await install.close();
});

const reset = () => ({
	type: "password-reset" as const,
	data: { resetPath: "/reset-password?token=secret-link-token", expiresInMinutes: 30 },
});

describe("the Email log", () => {
	test("records each email from Queued to Sent, with the server's answer, never its body", async () => {
		await admin.api.install.smtp.update({ ...SMTP, password: "a long smtp password abcd" });
		const queuedAt = install.clock.now();
		await install.sendSystemEmail({
			...reset(),
			to: { personId: superadminId },
			related: { kind: "person", id: superadminId },
		});

		const queued = await admin.api.install.emailLog.list({});
		expect(queued).toEqual({
			lines: [
				{
					id: expect.any(String),
					time: queuedAt,
					type: "password-reset",
					category: "security",
					recipient: superadmin.email,
					subject: "Reset your password",
					smtp: "install",
					status: "queued",
					attempts: 0,
					lastResponse: null,
					lastAttemptAt: null,
					nextAttemptAt: queuedAt,
					related: { kind: "person", id: superadminId },
				},
			],
			next: null,
		});

		await install.clock.advance(5_000);
		await install.drainJobs();

		const [line] = (await admin.api.install.emailLog.list({})).lines;
		expect(line).toMatchObject({
			time: queuedAt,
			status: "sent",
			attempts: 1,
			lastResponse: FAKE_SMTP_RESPONSE,
			lastAttemptAt: install.clock.now(),
			nextAttemptAt: null,
		});
		expect(JSON.stringify(line)).not.toContain("secret-link-token");
	});

	test("until the Install SMTP is set, emails are written to the log with a warning, and the Email log says so", async () => {
		const [result] = await install.sendSystemEmail({ ...reset(), to: { personId: superadminId } });

		expect(result?.status).toBe("logged");
		const written = install.logs.find((entry) => entry.emailId === result?.emailId);
		expect(written).toMatchObject({
			level: "warn",
			msg: "No SMTP is set, so this email was written to the log instead of being sent",
			email: { to: superadmin.email, subject: "Reset your password" },
		});
		expect((written?.email as { text?: string } | undefined)?.text).toContain(
			"https://admin.test/reset-password?token=secret-link-token",
		);

		expect((await install.drainJobs()).completed).toEqual([]);
		expect(install.mail.attempts).toEqual([]);
		expect((await admin.api.install.emailLog.list({})).lines).toEqual([
			expect.objectContaining({ status: "logged", smtp: "none", attempts: 0, recipient: superadmin.email }),
		]);
	});

	test("shows the newest first, a page at a time", async () => {
		for (const name of ["first", "second", "third"]) {
			await install.sendSystemEmail({
				type: "api-token-created",
				to: { personId: superadminId },
				data: { tokenName: name },
			});
			await install.clock.advance(1_000);
		}

		const page = await admin.api.install.emailLog.list({ limit: 2 });
		expect(page.lines.map((line) => line.subject)).toEqual([
			"A new API token was created",
			"A new API token was created",
		]);
		expect(page.next).toEqual(expect.any(String));
		const rest = await admin.api.install.emailLog.list({ after: page.next, limit: 2 });

		expect(rest.next).toBeNull();
		const times = [...page.lines, ...rest.lines].map((line) => line.time.getTime());
		expect(times).toHaveLength(3);
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});

	test("lines are deleted 90 days after the email, by a job that runs every day", async () => {
		await install.sendSystemEmail({
			type: "api-token-created",
			to: { personId: superadminId },
			data: { tokenName: "old" },
		});
		await install.clock.advance(60 * DAY);
		await install.sendSystemEmail({
			type: "api-token-created",
			to: { personId: superadminId },
			data: { tokenName: "newer" },
		});

		// Sessions end after 30 days, so sign in again to look.
		const lines = async () => (await (await install.signIn(superadmin)).api.install.emailLog.list({})).lines;

		await install.clock.advance(29 * DAY);
		await install.drainJobs();
		expect(await lines()).toHaveLength(2);

		await install.clock.advance(2 * DAY);
		await install.drainJobs();
		const left = await lines();
		expect(left).toHaveLength(1);
		expect(left[0]?.time).toEqual(new Date(install.clock.now().getTime() - 31 * DAY));
	});

	test("only the Superadmin can read it", async () => {
		await expect(install.browser().api.install.emailLog.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
