import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const FIREFOX_ON_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0";
const SAFARI_ON_IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_ON_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let install: TestInstall;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
});

afterAll(async () => {
	await install.close();
});

/** A new person with nobody else signed in as them. */
async function newPerson(): Promise<TestAccount> {
	const { account, browser } = await install.createMember({ workspaceId, role: "editor" });
	await browser.api.session.signOut();
	return account;
}

describe("your sessions", () => {
	test("list every browser signed in as you: device, network and when it was last used, newest first", async () => {
		const account = await newPerson();
		const laptop = await install.signIn(account, { address: "203.0.113.24", userAgent: FIREFOX_ON_MAC });
		await install.clock.advance(HOUR);
		const phone = await install.signIn(account, { address: "2001:db8:85a3:8d3::7334", userAgent: SAFARI_ON_IPHONE });
		const signedInAt = install.clock.now();

		const { sessions } = await phone.api.me.sessions.list();

		expect(sessions).toEqual([
			{
				id: expect.any(String),
				current: true,
				browser: "Safari",
				os: "iOS",
				network: "2001:db8:85a3:*",
				startedAt: signedInAt,
				lastUsedAt: signedInAt,
			},
			{
				id: expect.any(String),
				current: false,
				browser: "Firefox",
				os: "macOS",
				network: "203.0.113.*",
				startedAt: new Date(signedInAt.getTime() - HOUR),
				lastUsedAt: new Date(signedInAt.getTime() - HOUR),
			},
		]);
		const fromLaptop = (await laptop.api.me.sessions.list()).sessions;
		expect(fromLaptop.filter((session) => session.current).map((session) => session.browser)).toEqual(["Firefox"]);
	});

	test("show where and when a session was last used", async () => {
		const account = await newPerson();
		const laptop = await install.signIn(account, { address: "203.0.113.24", userAgent: CHROME_ON_WINDOWS });
		await install.clock.advance(2 * HOUR);

		laptop.address = "198.51.100.200";
		const { sessions } = await laptop.api.me.sessions.list();

		expect(sessions).toEqual([
			expect.objectContaining({
				browser: "Chrome",
				os: "Windows",
				network: "198.51.100.*",
				lastUsedAt: install.clock.now(),
			}),
		]);
	});

	test("leave out sessions that have ended, and people who aren't you", async () => {
		const account = await newPerson();
		const other = await newPerson();
		await install.signIn(account);
		await install.clock.advance(8 * DAY);
		const now = await install.signIn(account);
		await install.signIn(other);

		const { sessions } = await now.api.me.sessions.list();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.current).toBe(true);
	});

	test("an unknown browser and address are shown as unknown", async () => {
		const account = await newPerson();
		const browser = await install.signIn(account, { address: null, userAgent: "curl/8.0" });

		const { sessions } = await browser.api.me.sessions.list();

		expect(sessions).toEqual([expect.objectContaining({ browser: null, os: null, network: null })]);
	});
});

describe("revoking sessions", () => {
	test("one of them signs that browser out at once", async () => {
		const account = await newPerson();
		const laptop = await install.signIn(account);
		const phone = await install.signIn(account);
		const phoneSession = (await phone.api.me.sessions.list()).sessions.find((session) => session.current);

		await laptop.api.me.sessions.revoke({ sessionId: phoneSession?.id ?? "" });

		expect(await phone.api.session.current()).toEqual({ person: null });
		expect(await laptop.api.session.current()).toMatchObject({ person: { email: account.email } });
		expect((await laptop.api.me.sessions.list()).sessions.map((session) => session.id)).not.toContain(phoneSession?.id);
	});

	test("this browser's own session signs it out, as signing out does", async () => {
		const account = await newPerson();
		const laptop = await install.signIn(account);
		const own = (await laptop.api.me.sessions.list()).sessions.find((session) => session.current);

		await laptop.api.me.sessions.revoke({ sessionId: own?.id ?? "" });

		expect(laptop.cookies.size).toBe(0);
		expect(await laptop.api.session.current()).toEqual({ person: null });
	});

	test("every other session at once leaves only this one", async () => {
		const account = await newPerson();
		const laptop = await install.signIn(account);
		const phone = await install.signIn(account);
		const tablet = await install.signIn(account);

		const { revoked } = await laptop.api.me.sessions.revokeOthers();

		expect(revoked).toBe(2);
		expect(await phone.api.session.current()).toEqual({ person: null });
		expect(await tablet.api.session.current()).toEqual({ person: null });
		expect(await laptop.api.session.current()).toMatchObject({ person: { email: account.email } });
	});

	test("another person's session can't be revoked, and looks the same as one that doesn't exist", async () => {
		const account = await newPerson();
		const other = await newPerson();
		const mine = await install.signIn(account);
		const theirs = await install.signIn(other);
		const theirSession = (await theirs.api.me.sessions.list()).sessions[0];

		await expect(mine.api.me.sessions.revoke({ sessionId: theirSession?.id ?? "" })).rejects.toMatchObject({
			code: "SESSION_NOT_FOUND",
			status: 404,
		});
		await expect(
			mine.api.me.sessions.revoke({ sessionId: "00000000-0000-4000-8000-000000000000" }),
		).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", status: 404 });
		expect(await theirs.api.session.current()).toMatchObject({ person: { email: other.email } });
	});

	test("needs a session", async () => {
		await expect(install.browser().api.me.sessions.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	test("is recorded in the Audit log", async () => {
		const account = await newPerson();
		const laptop = await install.signIn(account);
		const phone = await install.signIn(account);
		const phoneSession = (await phone.api.me.sessions.list()).sessions.find((session) => session.current);
		await install.signIn(account);

		await laptop.api.me.sessions.revoke({ sessionId: phoneSession?.id ?? "" });
		await laptop.api.me.sessions.revokeOthers();

		const admin = await install.superadmin();
		const { entries } = await admin.api.audit.list({ limit: 5 });
		const personId = (await laptop.api.session.current()).person?.id;
		expect(entries.slice(0, 2)).toMatchObject([
			{ action: "session.revokeOthers", personId, via: { kind: "admin" }, details: { revoked: 1 } },
			{ action: "session.revoke", personId, via: { kind: "admin" }, details: { sessionId: phoneSession?.id } },
		]);
	});
});

describe("changing your password", () => {
	test("signs out every other session and keeps this one; only the new password signs in", async () => {
		const account = await newPerson();
		const laptop = await install.signIn(account);
		const phone = await install.signIn(account);

		await laptop.api.me.changePassword({ newPassword: "a brand new long password" });

		expect(await phone.api.session.current()).toEqual({ person: null });
		expect(await laptop.api.session.current()).toMatchObject({ person: { email: account.email } });
		await expect(install.signIn(account)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
		await expect(
			install.signIn({ email: account.email, password: "a brand new long password" }),
		).resolves.toBeDefined();
	});

	test("refuses a password the rules don't allow, and changes nothing", async () => {
		const account = await newPerson();
		const laptop = await install.signIn(account);
		const phone = await install.signIn(account);

		await expect(laptop.api.me.changePassword({ newPassword: "too short" })).rejects.toMatchObject({
			code: "PASSWORD_REFUSED",
			data: { problem: "too-short" },
		});

		expect(await phone.api.session.current()).toMatchObject({ person: { email: account.email } });
		await expect(install.signIn(account)).resolves.toBeDefined();
	});

	test("is recorded in the Audit log, without the password", async () => {
		const account = await newPerson();
		const laptop = await install.signIn(account);
		await install.signIn(account);

		await laptop.api.me.changePassword({ newPassword: "another brand new password" });

		const admin = await install.superadmin();
		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "password.change",
			personId: (await laptop.api.session.current()).person?.id,
			details: { signedOutSessions: 1 },
		});
		expect(JSON.stringify(entry)).not.toContain("another brand new password");
	});
});
