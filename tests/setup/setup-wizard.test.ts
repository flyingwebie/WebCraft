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

	test("claiming the Install is recorded in the Audit log, with who and how", async () => {
		const browser = install.browser();

		const { personId } = await browser.api.setup.claim({ token: install.setupToken() ?? "", ...account() });

		expect((await browser.api.audit.list()).entries).toEqual([
			{
				id: expect.any(String),
				at: install.clock.now(),
				action: "install.claim",
				personId,
				via: { kind: "admin" },
				workspaceId: null,
				siteId: null,
				details: { email: "ada@agency.example" },
			},
		]);
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

	// A token sits in logs, which are kept and copied about: it must not open the Install to whoever
	// reads an old one (the report's A1-9).
	test("only the newest token works: a restart prints a new one and the earlier one stops working", async () => {
		const before = install.setupToken() ?? "";
		await install.restart();
		const newest = install.setupToken() ?? "";
		expect(newest).not.toBe(before);

		await expect(install.browser().api.setup.checkToken({ token: before })).rejects.toMatchObject({
			code: "SETUP_TOKEN_INVALID",
		});
		await expect(install.browser().api.setup.claim({ token: before, ...account() })).rejects.toMatchObject({
			code: "SETUP_TOKEN_INVALID",
		});
		await install.browser().api.setup.claim({ token: newest, ...account() });
	});

	test("a token works for 24 hours; after that the Install is claimed with a new one", async () => {
		const token = install.setupToken() ?? "";
		await install.clock.advance(24 * 60 * 60 * 1000 - 60_000);
		await install.browser().api.setup.checkToken({ token });

		await install.clock.advance(60_000);
		await expect(install.browser().api.setup.checkToken({ token })).rejects.toMatchObject({
			code: "SETUP_TOKEN_INVALID",
			status: 403,
		});
		await expect(install.browser().api.setup.claim({ token, ...account() })).rejects.toMatchObject({
			code: "SETUP_TOKEN_INVALID",
		});
		expect(await install.browser().api.setup.state()).toMatchObject({ stage: "claim" });

		await install.restart();
		await install.browser().api.setup.claim({ token: install.setupToken() ?? "", ...account() });
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

describe("after the account step", () => {
	test("the signed-in Superadmin finishes setup, and the wizard is gone for good", async () => {
		const superadmin = install.browser();
		const token = install.setupToken() ?? "";
		await superadmin.api.setup.claim({ token, ...account() });

		await superadmin.api.setup.finish();

		expect(await superadmin.api.setup.state()).toEqual({ stage: "done" });
		expect(await install.browser().api.setup.state()).toEqual({ stage: "done" });
		await expect(superadmin.api.setup.finish()).rejects.toMatchObject({ code: "SETUP_STAGE" });
		await expect(install.browser().api.setup.checkToken({ token })).rejects.toMatchObject({ code: "SETUP_CLOSED" });
	});

	test("nobody signed out can finish setup for the Superadmin", async () => {
		await install.browser().api.setup.claim({ token: install.setupToken() ?? "", ...account() });

		await expect(install.browser().api.setup.finish()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(await install.browser().api.setup.state()).toEqual({ stage: "continue" });
	});

	test("the wizard can't be finished before the Install is claimed", async () => {
		await install.createSuperadmin();
		const superadmin = await install.signIn({
			email: "superadmin@agency.example",
			password: "a long enough test password",
		});

		// Created without the wizard, so setup is already finished.
		expect(await superadmin.api.setup.state()).toEqual({ stage: "done" });
		await expect(superadmin.api.setup.finish()).rejects.toMatchObject({ code: "SETUP_STAGE" });
	});
});

describe("the first client step", () => {
	async function claimed() {
		const superadmin = install.browser();
		const { personId } = await superadmin.api.setup.claim({ token: install.setupToken() ?? "", ...account() });
		return { superadmin, personId };
	}

	test("finishing with a Workspace name creates that Workspace and finishes setup", async () => {
		const { superadmin } = await claimed();

		const finished = await superadmin.api.setup.finish({ workspace: { name: " Acme Ltd " } });

		expect(finished).toEqual({
			stage: "done",
			workspace: { id: expect.any(String), name: "Acme Ltd", createdAt: install.clock.now() },
			site: null,
		});
		expect((await superadmin.api.workspaces.list()).workspaces).toMatchObject([
			{ id: finished.workspace?.id, name: "Acme Ltd", siteCount: 0 },
		]);
		expect(await superadmin.api.setup.state()).toEqual({ stage: "done" });
	});

	test("finishing with its first Site too creates the Site in the Workspace", async () => {
		const { superadmin } = await claimed();

		const finished = await superadmin.api.setup.finish({
			workspace: { name: "Acme Ltd", site: { name: "Acme Bakery", slug: " Acme-Bakery " } },
		});

		expect(finished.site).toEqual({
			id: expect.any(String),
			workspaceId: finished.workspace?.id ?? "",
			name: "Acme Bakery",
			slug: "acme-bakery",
			createdAt: install.clock.now(),
		});
		const { site } = await superadmin.api.sites.get({ siteId: finished.site?.id ?? "" });
		expect(site.name).toBe("Acme Bakery");
		expect(await superadmin.api.setup.state()).toEqual({ stage: "done" });
	});

	test("the Audit log records the Workspace and the Site as their own screens do", async () => {
		const { superadmin, personId } = await claimed();

		const { workspace, site } = await superadmin.api.setup.finish({
			workspace: { name: "Acme Ltd", site: { name: "Acme Bakery", slug: "acme-bakery" } },
		});

		const entries = (await superadmin.api.audit.list()).entries.filter((entry) => entry.action !== "install.claim");
		expect(entries).toEqual(
			expect.arrayContaining([
				{
					id: expect.any(String),
					at: install.clock.now(),
					action: "workspace.create",
					personId,
					via: { kind: "admin" },
					workspaceId: workspace?.id ?? "",
					siteId: null,
					details: { name: "Acme Ltd" },
				},
				{
					id: expect.any(String),
					at: install.clock.now(),
					action: "site.create",
					personId,
					via: { kind: "admin" },
					workspaceId: workspace?.id ?? "",
					siteId: site?.id ?? "",
					details: { name: "Acme Bakery", slug: "acme-bakery" },
				},
			]),
		);
		expect(entries).toHaveLength(2);
	});

	test("skipping it finishes setup without creating anything", async () => {
		const { superadmin } = await claimed();

		expect(await superadmin.api.setup.finish({})).toEqual({ stage: "done", workspace: null, site: null });
		expect((await superadmin.api.workspaces.list()).workspaces).toEqual([]);
	});

	test("a slug no Site may have creates nothing and leaves setup open to try again", async () => {
		const { superadmin } = await claimed();

		await expect(
			superadmin.api.setup.finish({ workspace: { name: "Acme Ltd", site: { name: "Admin", slug: "admin" } } }),
		).rejects.toMatchObject({ code: "SLUG_INVALID", data: { problem: "reserved" } });
		await expect(
			superadmin.api.setup.finish({ workspace: { name: "Acme Ltd", site: { name: "Acme", slug: "-acme" } } }),
		).rejects.toMatchObject({ code: "SLUG_INVALID", data: { problem: "shape" } });

		expect((await superadmin.api.workspaces.list()).workspaces).toEqual([]);
		expect(await superadmin.api.setup.state()).toEqual({ stage: "continue" });
		expect((await superadmin.api.audit.list()).entries.map((entry) => entry.action)).toEqual(["install.claim"]);

		await superadmin.api.setup.finish({ workspace: { name: "Acme Ltd", site: { name: "Acme", slug: "acme" } } });
		expect((await superadmin.api.workspaces.list()).workspaces).toMatchObject([{ name: "Acme Ltd", siteCount: 1 }]);
	});

	test("a slug another Site has creates nothing and leaves setup open", async () => {
		const { superadmin } = await claimed();
		const { workspace } = await superadmin.api.workspaces.create({ name: "Existing" });
		await superadmin.api.sites.create({ workspaceId: workspace.id, name: "Bakery", slug: "bakery" });

		await expect(
			superadmin.api.setup.finish({ workspace: { name: "Acme Ltd", site: { name: "Acme Bakery", slug: "bakery" } } }),
		).rejects.toMatchObject({ code: "SLUG_TAKEN", status: 409 });

		expect((await superadmin.api.workspaces.list()).workspaces.map((each) => each.name)).toEqual(["Existing"]);
		expect(await superadmin.api.setup.state()).toEqual({ stage: "continue" });
	});

	test("a missing Workspace or Site name is refused and creates nothing", async () => {
		const { superadmin } = await claimed();

		await expect(superadmin.api.setup.finish({ workspace: { name: "  " } })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(
			superadmin.api.setup.finish({ workspace: { name: "Acme Ltd", site: { name: " ", slug: "acme" } } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect((await superadmin.api.workspaces.list()).workspaces).toEqual([]);
		expect(await superadmin.api.setup.state()).toEqual({ stage: "continue" });
	});

	test("once setup is finished, it creates nothing", async () => {
		const { superadmin } = await claimed();
		await superadmin.api.setup.finish({});

		await expect(superadmin.api.setup.finish({ workspace: { name: "Acme Ltd" } })).rejects.toMatchObject({
			code: "SETUP_STAGE",
		});
		expect((await superadmin.api.workspaces.list()).workspaces).toEqual([]);
	});
});
