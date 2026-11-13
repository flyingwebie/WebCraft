// Install health and the Error log in the admin, in light and dark: the confirmation dialogs for
// Discard and Retry all from the keyboard, a cause's details opened from the keyboard (its stack
// scrolls), and the banner across the admin while part of the Install is Failing, shown once even
// while the older Backup and SMTP banners would otherwise say the same thing. Behaviour is tested
// at seam 1 (tests/health, tests/errors); the screens themselves are lines of screens.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { samplePing } from "@webcraft/core";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	// Two jobs that failed for good (tried three times, a minute apart), noted in the Error log too.
	await local.jobs.send(samplePing, { url: "https://status.unreachable.example/a" });
	await local.jobs.send(samplePing, { url: "https://status.unreachable.example/b" });
	for (let attempt = 0; attempt < 3; attempt++) {
		await local.drainJobs({ only: ["sample.ping"] });
		await local.clock.advance(2 * 60_000);
	}
	const admin = await local.superadmin();
	const superadminId = (await admin.api.session.current()).person?.id ?? "";
	await admin.api.errorLog.list({});
	// A Backup that failed: Install health's last check says the Backups part is Failing.
	await local.backup({ to: "/dev/null/backups/never.tar" }).catch(() => {});
	// The Install SMTP Failing too, so the page should show Install health's banner for it once,
	// not Install health's banner together with the older SmtpFailingBanner (review of #86).
	await admin.api.install.smtp.update({
		host: "smtp.agency.example",
		port: 587,
		security: "starttls",
		username: "mailer@agency.example",
		fromAddress: "noreply@agency.example",
		replyTo: null,
		password: "a long smtp password abcd",
	});
	local.mail.fail("421 4.7.0 Try again later");
	await local.sendSystemEmail({
		type: "api-token-created",
		to: { personId: superadminId },
		data: { tokenName: "first" },
	});
	await local.sendSystemEmail({
		type: "api-token-created",
		to: { personId: superadminId },
		data: { tokenName: "second" },
	});
	await local.drainJobs();
	await local.clock.advance(60_000);
	await local.drainJobs();
	await admin.api.installHealth.get({ refresh: true });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Install health, ${theme}`, () => {
		test("the banner across the admin while a part is Failing, linking to Install health", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/"));
			await page.waitForLoadState("networkidle");

			const banner = page.getByText("Part of the Install is failing");
			await banner.waitFor({ state: "visible" });
			expect(await page.getByText(/Failing now: .*Last Backup.*Email \(SMTP\)/).count()).toBeGreaterThan(0);
			// Backups and the Install SMTP are both Failing too, but Install health's banner says each
			// once: the older, per-part banners don't also show (review of #86).
			expect(await page.getByText("The last Backup failed").count()).toBe(0);
			expect(await page.getByText("The Install SMTP is failing").count()).toBe(0);
			await expectAccessibleScreen(page, `the health banner (${theme})`);
			await page.getByRole("link", { name: "Open Install health" }).click();
			await page.waitForURL(/\/install\/health$/);
		});

		test("Discard and Retry all of a queue ask first, from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/install/health"));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Discard all of sample.ping" }),
				"dialog",
				`Discard all (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Retry all of sample.ping" }),
				"dialog",
				`Retry all (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /^Discard the job that failed at/ }).first(),
				"dialog",
				`Discard one job (${theme})`,
			);
		});
	});

	describe(`the Error log, ${theme}`, () => {
		test("a cause's details open from the keyboard, with its stack", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/install/errors"));
			await page.waitForLoadState("networkidle");

			const details = page.getByRole("button", { name: /^Details/ }).first();
			await details.focus();
			await page.keyboard.press("Enter");
			await page.getByText("Stack of the newest example").waitFor({ state: "visible" });
			// Its button now hides them again, and says it is expanded.
			const hide = page.getByRole("button", { name: /^Hide details/ });
			expect(await hide.getAttribute("aria-expanded")).toBe("true");

			await expectNoAxeViolations(page, `a cause's details (${theme})`);
			await expectAccessibleScreen(page, `the Error log with a cause open (${theme})`);
		});
	});
}
