// `webcraft admin reset-password <email>` recovers a Superadmin who forgot their password and can't
// receive the reset email: nobody on the Install can change another person's password. These tests
// run the real command, in an empty directory so Bun loads no `.env`, with the Install's environment.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";
import { addAuthenticator, signInWithAuthenticator } from "../harness/two-factor.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "apps/cli/src/main.ts");
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-cli-"));
const NEW_PASSWORD = "a password typed on the server";

let install: TestInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

/** Runs the command with `input` on standard input, as `printf '%s\n' "$PASSWORD" | webcraft …` does. */
async function run(args: string[], input = "") {
	const child = Bun.spawn(["bun", CLI, "admin", "reset-password", ...args], {
		cwd: EMPTY_DIRECTORY,
		env: { PATH: process.env.PATH ?? "", ...install.env },
		stdin: new Blob([input]),
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

describe("webcraft admin reset-password", () => {
	test("refuses a password the rules don't allow, an unknown address and a password on the command line, changing nothing", async () => {
		const short = await run([superadmin.email], "too short\n");
		expect(short.code).toBe(1);
		expect(short.stderr).toContain("at least 12 characters");

		const nobody = await run(["nobody@agency.example"], `${NEW_PASSWORD}\n`);
		expect(nobody.code).toBe(1);
		expect(nobody.stderr).toContain("Nobody signs in with nobody@agency.example");

		const typed = await run([superadmin.email, "--password", NEW_PASSWORD]);
		expect(typed.code).toBe(1);
		expect(typed.stderr).toContain("never on the command line");
		expect(typed.stderr).not.toContain(NEW_PASSWORD);

		for (const args of [[], ["a@agency.example", "b@agency.example"], ["--all"]]) {
			const { code, stderr } = await run(args, `${NEW_PASSWORD}\n`);
			expect(code).toBe(1);
			expect(stderr).toContain("Usage: webcraft");
		}
		await expect(install.signIn(superadmin)).resolves.toBeDefined();
	});

	test("gives the Superadmin the new password: they are signed out everywhere, keep their second factor, and it is logged", async () => {
		const browser = await install.superadmin();
		const { secret } = await addAuthenticator(install, browser, superadmin.password);

		const { code, stdout, stderr } = await run(["SuperAdmin@Agency.example"], `${NEW_PASSWORD}\n`);

		expect(code).toBe(0);
		expect(stdout).toContain("Changed the password of superadmin@agency.example");
		expect(`${stdout}${stderr}`).not.toContain(NEW_PASSWORD);
		expect((await browser.api.session.current()).person).toBeNull();
		await expect(install.browser().api.session.signIn(superadmin)).rejects.toMatchObject({
			code: "INVALID_CREDENTIALS",
		});
		const account = { email: superadmin.email, password: NEW_PASSWORD };
		expect(await install.browser().api.session.signIn(account)).toMatchObject({
			person: null,
			secondStep: { methods: ["authenticator", "backupCode"] },
		});
		const signedIn = await signInWithAuthenticator(install, account, secret);
		const entry = (await signedIn.api.audit.list()).entries.find((found) => found.action === "password.reset");
		expect(entry).toMatchObject({
			personId: null,
			via: { kind: "command", name: "reset-password" },
			workspaceId: null,
			details: { email: superadmin.email, by: "command", signedOutSessions: 1 },
		});
		expect(JSON.stringify(entry)).not.toContain(NEW_PASSWORD);
	});
});
