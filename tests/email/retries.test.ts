import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
	await admin.api.install.smtp.update({ ...SMTP, password: "a long smtp password abcd" });
});

afterEach(async () => {
	await install.close();
});

async function sendOne(tokenName = "deploy script") {
	const [result] = await install.sendSystemEmail({
		type: "api-token-created",
		to: { personId: superadminId },
		data: { tokenName },
	});
	return result?.emailId ?? "";
}

async function line(emailId: string) {
	const { lines } = await admin.api.install.emailLog.list({});
	const found = lines.find((candidate) => candidate.id === emailId);
	if (!found) throw new Error(`No Email log line ${emailId}.`);
	return found;
}

describe("a send that fails", () => {
	test("is retried with a growing wait for about 24 hours, then Failed", async () => {
		install.mail.fail("421 4.7.0 Try again later");
		const queuedAt = install.clock.now().getTime();
		const emailId = await sendOne();

		await install.drainJobs();
		expect(await line(emailId)).toMatchObject({
			status: "retrying",
			attempts: 1,
			lastResponse: "421 4.7.0 Try again later",
			nextAttemptAt: new Date(queuedAt + MINUTE),
		});

		await install.clock.advance(30_000);
		await install.drainJobs();
		expect((await line(emailId)).attempts).toBe(1);

		// Follow the retries, each at the time the Email log says it is due.
		const attemptMinutes = [0];
		for (let current = await line(emailId); current.status === "retrying"; current = await line(emailId)) {
			const due = current.nextAttemptAt?.getTime() ?? 0;
			await install.clock.set(new Date(due));
			await install.drainJobs();
			attemptMinutes.push((due - queuedAt) / MINUTE);
		}

		expect(attemptMinutes).toEqual([0, 1, 3, 7, 15, 31, 63, 127, 255, 495, 735, 975, 1215, 1440]);
		expect(await line(emailId)).toMatchObject({ status: "failed", attempts: 14, nextAttemptAt: null });
		expect(install.mail.sent).toEqual([]);
		expect(install.logs).toContainEqual(
			expect.objectContaining({
				level: "warn",
				msg: "An email was not sent after about 24 hours of attempts, so it is Failed",
				emailId,
			}),
		);

		await install.clock.advance(6 * HOUR);
		await install.drainJobs();
		expect((await line(emailId)).attempts).toBe(14);
	});

	test("goes out once the server takes it again", async () => {
		install.mail.fail("connect ECONNREFUSED 203.0.113.5:587");
		const emailId = await sendOne();
		await install.drainJobs();

		install.mail.accept();
		await install.clock.advance(MINUTE);
		await install.drainJobs();

		expect(await line(emailId)).toMatchObject({ status: "sent", attempts: 2, nextAttemptAt: null });
		expect(install.mail.sent.map((email) => email.subject)).toEqual(["A new API token was created"]);
	});

	test("every attempt carries the same Message-ID, so a mail client can drop a copy sent twice", async () => {
		install.mail.fail("421 Try again later");
		await sendOne();
		await install.drainJobs();
		install.mail.accept();
		await install.clock.advance(MINUTE);
		await install.drainJobs();

		const ids = install.mail.attempts.map((email) => email.messageId);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toMatch(/^<[0-9a-f-]{36}@agency\.example>$/);
		expect(ids[1]).toBe(ids[0]);
	});

	test("to an address the server refuses for good is Failed at once, and isn't held against the server", async () => {
		install.mail.rejectRecipient(superadmin.email, "550 5.1.1 No such user here");
		const emailId = await sendOne();
		await install.drainJobs();
		await install.clock.advance(HOUR);
		await install.drainJobs();

		expect(await line(emailId)).toMatchObject({
			status: "failed",
			attempts: 1,
			lastResponse: "550 5.1.1 No such user here",
		});
		expect((await admin.api.install.smtp.get()).health).toMatchObject({ state: "working", failuresInARow: 0 });
	});
});

describe("Failing", () => {
	test("after 3 failures in a row the Install SMTP is Failing: Install settings and a notice tell the Superadmin, and it is logged", async () => {
		install.mail.fail("535 5.7.8 Authentication failed");
		await sendOne("first");
		await sendOne("second");
		await install.drainJobs();
		expect((await admin.api.install.smtp.get()).health).toMatchObject({ state: "working", failuresInARow: 2 });
		expect((await admin.api.shell.context()).banners.smtpFailing).toBe(false);

		await install.clock.advance(MINUTE);
		await install.drainJobs();

		expect((await admin.api.install.smtp.get()).health).toEqual({
			state: "failing",
			failuresInARow: 4,
			failingSince: install.clock.now(),
			lastResponse: "535 5.7.8 Authentication failed",
		});
		expect((await admin.api.shell.context()).banners.smtpFailing).toBe(true);
		expect((await install.browser().api.shell.context()).banners.smtpFailing).toBe(false);
		expect(install.logs.filter((entry) => entry.msg.includes("Failing") && entry.level === "error")).toEqual([
			expect.objectContaining({ smtp: "install", failuresInARow: 3, lastResponse: "535 5.7.8 Authentication failed" }),
		]);
	});

	test("a send that goes through clears it", async () => {
		install.mail.fail("421 Service not available");
		for (const name of ["a", "b", "c"]) await sendOne(name);
		await install.drainJobs();
		expect((await admin.api.install.smtp.get()).health.state).toBe("failing");

		install.mail.accept();
		await install.clock.advance(MINUTE);
		await install.drainJobs();

		expect((await admin.api.install.smtp.get()).health).toEqual({
			state: "working",
			failuresInARow: 0,
			failingSince: null,
			lastResponse: null,
		});
		expect((await admin.api.shell.context()).banners.smtpFailing).toBe(false);
		expect(install.logs).toContainEqual(
			expect.objectContaining({ level: "info", msg: "The SMTP server works again: it is no longer Failing" }),
		);
	});

	test("new settings start a clean record", async () => {
		install.mail.fail("421 Service not available");
		for (const name of ["a", "b", "c"]) await sendOne(name);
		await install.drainJobs();

		await admin.api.install.smtp.update({ ...SMTP, host: "smtp2.agency.example" });

		expect((await admin.api.install.smtp.get()).health).toMatchObject({ state: "working", failuresInARow: 0 });
	});
});
