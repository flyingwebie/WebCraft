import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

beforeEach(async () => {
	install = await createTestInstall();
});

afterEach(async () => {
	await install.close();
});

describe("on a fresh Install", () => {
	test("the web process prints a setup token and a link to the setup wizard in its log", async () => {
		const printed = install.logs.find((entry) => typeof entry.setupToken === "string");

		expect(printed?.level).toBe("warn");
		expect(printed?.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(printed?.setupUrl).toBe(`https://admin.test/setup?token=${printed?.setupToken}`);
	});

	test("the admin opens the setup wizard", async () => {
		const browser = install.browser();

		expect(await browser.api.setup.state()).toEqual({ stage: "claim" });
	});
});

const PASSWORD = "correct horse battery staple";

function account(
	overrides: Partial<{ name: string; email: string; password: string; adminLanguage: "en" | "it" }> = {},
) {
	return {
		name: "Ada Lovelace",
		email: "ada@agency.example",
		password: PASSWORD,
		adminLanguage: "en" as const,
		...overrides,
	};
}

describe("the setup token", () => {
	test("the wizard refuses a token the web process never printed", async () => {
		const browser = install.browser();

		await expect(browser.api.setup.checkToken({ token: "x".repeat(43) })).rejects.toMatchObject({
			code: "SETUP_TOKEN_INVALID",
			status: 403,
		});
	});

	test("the wizard accepts the token from the log, with the spaces a copy picks up", async () => {
		const browser = install.browser();

		await browser.api.setup.checkToken({ token: ` ${install.setupToken()}\n` });
	});

	test("claiming the Install with it creates the Superadmin and signs them in", async () => {
		const browser = install.browser();

		await browser.api.setup.claim({ token: install.setupToken() ?? "", ...account({ email: " Ada@Agency.Example " }) });

		expect(await browser.api.session.current()).toMatchObject({
			person: { name: "Ada Lovelace", email: "ada@agency.example", installRole: "superadmin" },
		});
		expect(await browser.api.setup.state()).toEqual({ stage: "continue" });
	});

	test("works only once: nobody can claim the Install again, with it or any other token", async () => {
		const token = install.setupToken() ?? "";
		await install.browser().api.setup.claim({ token, ...account() });

		const someoneElse = install.browser();
		await expect(someoneElse.api.setup.checkToken({ token })).rejects.toMatchObject({ code: "SETUP_CLOSED" });
		await expect(
			someoneElse.api.setup.claim({ token, ...account({ email: "mallory@example.org" }) }),
		).rejects.toMatchObject({ code: "SETUP_CLOSED", status: 410 });
		expect(await someoneElse.api.session.current()).toEqual({ person: null });
	});

	test("a token printed before the web process restarted still works", async () => {
		const before = install.setupToken() ?? "";
		await install.restart();
		expect(install.setupToken()).not.toBe(before);

		await install.browser().api.setup.claim({ token: before, ...account() });
	});

	test("once a Superadmin exists, a restart prints no new token", async () => {
		await install.browser().api.setup.claim({ token: install.setupToken() ?? "", ...account() });
		const printed = install.logs.filter((entry) => typeof entry.setupToken === "string").length;

		await install.restart();

		expect(install.logs.filter((entry) => typeof entry.setupToken === "string")).toHaveLength(printed);
	});
});

describe("the Superadmin account", () => {
	test("needs a password of at least 12 characters, and a refused one leaves the token working", async () => {
		const browser = install.browser();
		const token = install.setupToken() ?? "";

		await expect(browser.api.setup.claim({ token, ...account({ password: "short pass1" }) })).rejects.toMatchObject({
			code: "PASSWORD_REFUSED",
			data: { problem: "too-short" },
		});
		await browser.api.setup.claim({ token, ...account({ password: "twelve chars" }) });
	});

	test("needs a usable email address", async () => {
		const browser = install.browser();

		await expect(
			browser.api.setup.claim({ token: install.setupToken() ?? "", ...account({ email: "ada at agency" }) }),
		).rejects.toMatchObject({ code: "EMAIL_INVALID" });
	});

	test("needs a name", async () => {
		const browser = install.browser();

		await expect(
			browser.api.setup.claim({ token: install.setupToken() ?? "", ...account({ name: "  " }) }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
