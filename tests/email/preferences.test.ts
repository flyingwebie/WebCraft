import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestAccount;
let browser: TestBrowser;
let personId: string;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
	browser = await install.signIn(superadmin);
	personId = (await browser.api.session.current()).person?.id ?? "";
	await browser.api.install.smtp.update({
		host: "smtp.agency.example",
		port: 587,
		security: "starttls",
		username: null,
		fromAddress: "noreply@agency.example",
		replyTo: null,
	});
});

afterAll(async () => {
	await install.close();
});

beforeEach(async () => {
	install.mail.clear();
	await browser.api.me.emails.update({ turnedOff: [] });
});

const REVIEW = {
	type: "review-submitted",
	data: { authorName: "Ada", itemTitle: "Spring menu", siteName: "Acme Bakery", reviewPath: "/review/1" },
} as const;

describe("email switches", () => {
	test("list every System email type, by category; all are on until the person turns one off", async () => {
		const { emails } = await browser.api.me.emails.get();

		expect(emails.filter((email) => email.category === "work").map((email) => email.type)).toEqual([
			"review-submitted",
			"review-result",
			"scheduled-publish-failed",
			"ai-key-cap",
			"module-message",
		]);
		expect(emails.filter((email) => email.category === "alert").map((email) => email.type)).toEqual([
			"domain-unreachable",
			"site-smtp-failing",
			"media-quota-warning",
			"webhook-switched-off",
		]);
		expect(emails.find((email) => email.type === "password-reset")).toEqual({
			type: "password-reset",
			category: "security",
			on: true,
			canTurnOff: false,
		});
		expect(emails.every((email) => email.on)).toBe(true);
	});

	test("a work email a person turned off isn't sent to them; other recipients still get it", async () => {
		await browser.api.me.emails.update({ turnedOff: ["review-submitted", "domain-unreachable"] });
		expect((await browser.api.me.emails.get()).emails.filter((email) => !email.on).map((email) => email.type)).toEqual([
			"review-submitted",
			"domain-unreachable",
		]);

		const report = await install.sendSystemEmail({
			...REVIEW,
			to: [{ personId }, { email: "editor@client.example" }],
		});
		await install.drainJobs();

		expect(report.map(({ recipient, status }) => ({ recipient, status }))).toEqual([
			{ recipient: superadmin.email, status: "turned-off" },
			{ recipient: "editor@client.example", status: "queued" },
		]);
		expect(install.mail.sent.map((email) => email.to)).toEqual(["editor@client.example"]);
	});

	test("turned back on, it is sent again", async () => {
		await browser.api.me.emails.update({ turnedOff: ["review-submitted"] });
		await browser.api.me.emails.update({ turnedOff: [] });

		await install.sendSystemEmail({ ...REVIEW, to: { personId } });
		await install.drainJobs();

		expect(install.mail.sent.map((email) => email.to)).toEqual([superadmin.email]);
	});

	test("security emails can't be turned off", async () => {
		await expect(browser.api.me.emails.update({ turnedOff: ["password-reset"] })).rejects.toMatchObject({
			code: "EMAIL_ALWAYS_SENT",
		});

		await install.sendSystemEmail({
			type: "password-reset",
			to: { personId },
			data: { resetPath: "/reset-password?token=t", expiresInMinutes: 30 },
		});
		await install.drainJobs();
		expect(install.mail.sent.map((email) => email.subject)).toEqual(["Reset your password"]);
	});

	test("refuses a type that doesn't exist, and people who aren't signed in", async () => {
		// @ts-expect-error The typed client already refuses it; a raw call must be refused too.
		await expect(browser.api.me.emails.update({ turnedOff: ["newsletter"] })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(install.browser().api.me.emails.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
