// The email screens in the states a path alone can't reach: an SMTP set, a test email delivered,
// the password being replaced, an Email log with lines, and the notice of a Failing Install SMTP.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type LocalSmtpServer, startSmtpServer, type TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let browserInstall: BrowserInstall;
let superadmin: TestAccount;
let smtpServer: LocalSmtpServer;

beforeAll(async () => {
	browserInstall = await startBrowserInstall();
	superadmin = await browserInstall.createSuperadmin();
	smtpServer = await startSmtpServer({ username: "mailer", password: "the smtp password 1234" });
	const { install } = browserInstall;
	const api = (await install.signIn(superadmin)).api;
	// The web process sends test emails with the real Mailer, to this local server.
	await api.install.smtp.update({
		host: smtpServer.host,
		port: smtpServer.port,
		security: "none",
		username: "mailer",
		password: "the smtp password 1234",
		fromAddress: "noreply@agency.example",
		replyTo: null,
	});

	// Email log lines in every state: sent, retrying and failed.
	const personId = (await api.session.current()).person?.id ?? "";
	await install.sendSystemEmail({ type: "api-token-created", to: { personId }, data: { tokenName: "deploy" } });
	await install.drainJobs();
	install.mail.rejectRecipient("gone@client.example");
	await install.sendSystemEmail({
		type: "staff-invite",
		to: { email: "gone@client.example" },
		data: { inviterName: "Sam", acceptPath: "/invites/a", expiresInDays: 7 },
	});
	await install.drainJobs();
	install.mail.accept();
	install.mail.fail("421 4.7.0 Try again later");
	await install.sendSystemEmail({
		type: "password-reset",
		to: { personId },
		data: { resetPath: "/reset-password?token=t", expiresInMinutes: 30 },
	});
	await install.drainJobs();
	install.mail.accept();
	// One failure, not three: the Install SMTP isn't Failing yet.
	expect((await api.install.smtp.get()).health.state).toBe("working");
});

afterAll(async () => {
	await smtpServer.close();
	await browserInstall.close();
});

for (const theme of THEMES) {
	describe(`email screens, ${theme}`, () => {
		test("Email (SMTP) with an SMTP set, a test email delivered and the password being replaced", async () => {
			const page = await browserInstall.newPage(theme);
			await browserInstall.signIn(page, superadmin);
			await page.goto(browserInstall.adminUrl("/settings/email"));
			await page.waitForLoadState("networkidle");

			await page.getByRole("button", { name: "Send test email" }).click();
			await page.getByRole("status").getByText("Delivered to").waitFor();
			await expectAccessibleScreen(page, `Email (SMTP), test email delivered (${theme})`);

			await page.getByRole("button", { name: "Replace" }).click();
			await page.waitForFunction(() => document.activeElement?.id === "smtp-password");
			await expectAccessibleScreen(page, `Email (SMTP), replacing the password (${theme})`);
		});

		test("Email (SMTP) refusing what's wrong in the form", async () => {
			const page = await browserInstall.newPage(theme);
			await browserInstall.signIn(page, superadmin);
			await page.goto(browserInstall.adminUrl("/settings/email"));
			await page.waitForLoadState("networkidle");

			await page.locator("#smtp-host").fill("");
			await page.locator("#branding-accentColour").fill("orange");
			await page.getByRole("button", { name: "Save branding" }).click();
			await page.locator("#branding-accentColour-error").waitFor();
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await page.locator("#smtp-host-error").waitFor();
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("smtp-host");
			await expectAccessibleScreen(page, `Email (SMTP), refused (${theme})`);
		});

		test("the Email log with sent, retrying and failed emails", async () => {
			const page = await browserInstall.newPage(theme);
			await browserInstall.signIn(page, superadmin);
			await page.goto(browserInstall.adminUrl("/email-log"));
			await page.waitForLoadState("networkidle");

			await page.getByRole("cell", { name: "Retrying" }).first().waitFor();
			await expectAccessibleScreen(page, `Email log (${theme})`);
		});

		test("the notice of a Failing Install SMTP, and Email (SMTP) while it is Failing", async () => {
			const { install } = browserInstall;
			const api = (await install.signIn(superadmin)).api;
			const personId = (await api.session.current()).person?.id ?? "";
			install.mail.fail("535 5.7.8 Authentication failed");
			for (const tokenName of ["a", "b", "c"]) {
				await install.sendSystemEmail({ type: "api-token-created", to: { personId }, data: { tokenName } });
			}
			await install.drainJobs();
			try {
				const page = await browserInstall.newPage(theme);
				await browserInstall.signIn(page, superadmin);
				await page.getByText("The Install SMTP is failing").waitFor();
				await expectAccessibleScreen(page, `Overview with the Failing SMTP notice (${theme})`);

				await page.goto(browserInstall.adminUrl("/settings/email"));
				await page.waitForLoadState("networkidle");
				await page.getByRole("heading", { name: "This SMTP is failing" }).waitFor();
				await expectAccessibleScreen(page, `Email (SMTP) while Failing (${theme})`);
			} finally {
				// Saving the settings again gives the server a clean record, leaving the retrying emails as they are.
				install.mail.accept();
				const { settings } = await api.install.smtp.get();
				if (settings) await api.install.smtp.update({ ...settings, password: undefined });
			}
		});
	});
}
