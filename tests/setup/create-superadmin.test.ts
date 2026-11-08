// `webcraft admin create-superadmin <email>` claims a fresh Install without the wizard. These tests
// run the real command, in an empty directory so Bun loads no `.env`, with the Install's environment.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "apps/cli/src/main.ts");
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-cli-"));
// A real process does the real leaked-password lookup (or accepts the password when offline), so
// this one must not be on any leaked list.
const PASSWORD = "ops team keeps this webcraft install safe 2026";

let install: TestInstall;

beforeEach(async () => {
	install = await createTestInstall();
});

afterEach(async () => {
	await install.close();
});

async function createSuperadmin(args: string[], stdin: string) {
	const child = Bun.spawn(["bun", CLI, "admin", "create-superadmin", ...args], {
		cwd: EMPTY_DIRECTORY,
		env: { PATH: process.env.PATH ?? "", ...install.env },
		stdin: new TextEncoder().encode(stdin),
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

describe("webcraft admin create-superadmin", () => {
	test("creates the Superadmin with the password from standard input, and they can sign in", async () => {
		const { code, stdout } = await createSuperadmin(["Ops@Agency.example", "--name", "Ops Team"], `${PASSWORD}\n`);

		expect(code).toBe(0);
		expect(stdout).toContain("Created the Superadmin ops@agency.example.");
		expect(stdout).toContain("https://admin.test/sign-in");
		const browser = await install.signIn({ email: "ops@agency.example", password: PASSWORD });
		expect(await browser.api.session.current()).toMatchObject({
			person: { name: "Ops Team", email: "ops@agency.example", installRole: "superadmin" },
		});
	});

	test("is recorded in the Audit log as done by the command", async () => {
		await createSuperadmin(["ops@agency.example"], `${PASSWORD}\n`);

		const browser = await install.signIn({ email: "ops@agency.example", password: PASSWORD });
		const { person } = await browser.api.session.current();
		expect((await browser.api.audit.list()).entries).toEqual([
			{
				id: expect.any(String),
				at: expect.any(Date),
				action: "superadmin.create",
				personId: person?.id ?? null,
				via: { kind: "command", name: "create-superadmin" },
				workspaceId: null,
				siteId: null,
				details: { email: "ops@agency.example" },
			},
		]);
	});

	test("finishes setup: the wizard and the setup token in the log stop working", async () => {
		const token = install.setupToken() ?? "";

		await createSuperadmin(["ops@agency.example"], `${PASSWORD}\n`);

		const browser = install.browser();
		expect(await browser.api.setup.state()).toEqual({ stage: "done" });
		await expect(browser.api.setup.checkToken({ token })).rejects.toMatchObject({ code: "SETUP_CLOSED" });
	});

	test("names the Superadmin after their email when no name is given, and sets the Admin language", async () => {
		await createSuperadmin(["giulia@agency.example", "--language", "it"], `${PASSWORD}\n`);

		const browser = await install.signIn({ email: "giulia@agency.example", password: PASSWORD });
		expect(await browser.api.session.current()).toMatchObject({ person: { name: "giulia", adminLanguage: "it" } });
	});

	test("refuses a password given on the command line", async () => {
		const { code, stderr } = await createSuperadmin(["ops@agency.example", "--password", PASSWORD], "");

		expect(code).toBe(1);
		expect(stderr).toContain("never on the command line");
		expect(await install.browser().api.setup.state()).toEqual({ stage: "claim" });
	});

	test("refuses a password shorter than 12 characters, creating nobody", async () => {
		const { code, stderr } = await createSuperadmin(["ops@agency.example"], "too short\n");

		expect(code).toBe(1);
		expect(stderr).toContain("at least 12 characters");
		expect(stderr).not.toContain("too short");
		expect(await install.browser().api.setup.state()).toEqual({ stage: "claim" });
	});

	test("refuses when the Install already has a Superadmin", async () => {
		await install.createSuperadmin();

		const { code, stderr } = await createSuperadmin(["second@agency.example"], `${PASSWORD}\n`);

		expect(code).toBe(1);
		expect(stderr).toContain("already has a Superadmin");
	});

	test("refuses a malformed email", async () => {
		const { code, stderr } = await createSuperadmin(["not-an-email"], `${PASSWORD}\n`);

		expect(code).toBe(1);
		expect(stderr).toContain("email address");
	});
});
