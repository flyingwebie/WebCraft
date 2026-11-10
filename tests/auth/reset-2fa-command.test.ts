// `webcraft admin reset-2fa <email>` recovers a Superadmin who lost their second factors: nobody on
// the Install can reset the Superadmin's. These tests run the real command, in an empty directory
// so Bun loads no `.env`, with the Install's environment.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";
import { softwareAuthenticator } from "../harness/passkeys.ts";
import { addAuthenticator } from "../harness/two-factor.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "apps/cli/src/main.ts");
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-cli-"));

let install: TestInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

async function run(args: string[]) {
	const child = Bun.spawn(["bun", CLI, "admin", "reset-2fa", ...args], {
		cwd: EMPTY_DIRECTORY,
		env: { PATH: process.env.PATH ?? "", ...install.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

describe("webcraft admin reset-2fa", () => {
	test("resets the Superadmin's second factors: they sign in with their password, are emailed, and it is logged", async () => {
		const browser = await install.superadmin();
		await addAuthenticator(install, browser, superadmin.password);
		const { options } = await browser.api.me.twoFactor.passkeyOptions();
		await browser.api.me.twoFactor.addPasskey({
			credential: await softwareAuthenticator().create(options),
			name: "Key",
		});
		expect((await install.browser().api.session.signIn(superadmin)).secondStep).not.toBeNull();

		const { code, stdout, stderr } = await run(["SuperAdmin@Agency.example"]);

		expect(code).toBe(0);
		expect(stdout).toContain("Reset the two-factor authentication of superadmin@agency.example");
		expect((await browser.api.session.current()).person).toBeNull();
		const signedIn = install.browser();
		expect(await signedIn.api.session.signIn(superadmin)).toMatchObject({ secondStep: null });
		expect(await signedIn.api.me.twoFactor.get()).toMatchObject({ authenticator: null, passkeys: [] });
		const entry = (await signedIn.api.audit.list()).entries.find((found) => found.action === "twoFactor.reset");
		expect(entry).toMatchObject({
			personId: null,
			via: { kind: "command", name: "reset-2fa" },
			workspaceId: null,
			details: { email: superadmin.email, authenticator: true, passkeys: 1 },
		});
		// No Install SMTP is set yet, so the command writes the email to its log, as web and worker do.
		const logged = stderr
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { emailType?: string; email?: { to: string; subject: string; text: string } })
			.find((entry) => entry.emailType === "two-factor-reset");
		expect(logged?.email).toMatchObject({
			to: superadmin.email,
			subject: "Your two-factor authentication was reset",
			text: expect.stringContaining("was reset with a command on the server"),
		});
	});

	test("with the Install SMTP set, the email goes out through the worker", async () => {
		const admin = await install.superadmin();
		await admin.api.session.confirmIdentity({ password: superadmin.password });
		await admin.api.install.smtp.update({
			host: "smtp.agency.example",
			port: 587,
			security: "starttls",
			username: "webcraft",
			fromAddress: "webcraft@agency.example",
			replyTo: null,
			password: "an SMTP password",
		});
		const staff = await install.createStaff({ workspaces: "all" });
		await addAuthenticator(install, staff.browser);
		// The email about the app goes out first, so the next one to this address is the command's.
		expect((await install.lastEmailTo(staff.account.email)).subject).toBe(
			"An authenticator app was added to your account",
		);

		expect((await run([staff.account.email])).code).toBe(0);

		// The command queued the email by the real clock: the test Install's clock catches up first.
		await install.clock.set(new Date(Date.now() + 60_000));
		const email = await install.lastEmailTo(staff.account.email);
		expect(email.subject).toBe("Your two-factor authentication was reset");
		expect(install.mail.sent.some((sent) => sent.to === staff.account.email && sent.subject === email.subject)).toBe(
			true,
		);
	});

	test("refuses an address nobody signs in with, changing nothing", async () => {
		const { code, stderr } = await run(["nobody@agency.example"]);

		expect(code).toBe(1);
		expect(stderr).toContain("Nobody signs in with nobody@agency.example");
	});

	test("needs exactly one email address", async () => {
		for (const args of [[], ["a@agency.example", "b@agency.example"], ["--all"]]) {
			const { code, stderr } = await run(args);
			expect(code).toBe(1);
			expect(stderr).toContain("Usage: webcraft");
		}
	});
});
