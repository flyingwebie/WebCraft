// Password recovery: a person who forgot their password asks for a link by email, and chooses a
// new one with it. The answer never tells whether an address has an account; the link works once,
// for 30 minutes; a reset ends every session and never touches a second factor.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import {
	createTestInstall,
	fromAddress,
	TEST_ADMIN_ORIGIN,
	TEST_PASSWORD,
	type TestAccount,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";
import { approveAiClient } from "../harness/mcp.ts";
import { addAuthenticator, confirmIfAsked, signInWithAuthenticator } from "../harness/two-factor.ts";

const MINUTE = 60 * 1000;
const NEW_PASSWORD = "a brand new password to use";
const RESET_SUBJECT = "Reset your password";
const RANGE = /^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/;

let install: TestInstall;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
});

afterAll(async () => {
	await install.close();
});

beforeEach(() => {
	install.http.reset();
});

async function newPerson(): Promise<TestAccount & { personId: string; browser: TestBrowser }> {
	const { account, personId, browser } = await install.createMember({ workspaceId, role: "owner" });
	return { ...account, personId, browser };
}

/** Asks for a reset link as a signed-out visitor does, from a new address each time. */
function request(email: string, browser = install.browser()) {
	return browser.api.passwordReset.request({ email });
}

/** The reset emails that went to an address, oldest first. */
async function resetEmailsTo(address: string) {
	await install.drainJobs();
	return install.logs
		.map((entry) => entry.email as { to?: string; subject?: string; text?: string } | undefined)
		.filter((email) => email?.to === address && email.subject === RESET_SUBJECT);
}

/** Asks for a link for the person and answers the newest one they were sent. */
async function linkFor(email: string): Promise<URL> {
	await request(email);
	const text = (await resetEmailsTo(email)).at(-1)?.text ?? "";
	const link = text.match(/https?:\/\/\S+/)?.[0];
	if (!link) throw new Error(`No reset link went to ${email}.`);
	return new URL(link);
}

const tokenOf = (link: URL) => link.searchParams.get("token") ?? "";

describe("asking for a reset link", () => {
	test("answers the same for an address with an account and one without, and emails only the person", async () => {
		const person = await newPerson();

		const known = await request(person.email);
		const unknown = await request("nobody-here@client.example");

		expect(known).toEqual({ ok: true });
		expect(unknown).toEqual(known);
		expect(await resetEmailsTo(person.email)).toHaveLength(1);
		expect(await resetEmailsTo("nobody-here@client.example")).toHaveLength(0);
	});

	test("the link is on the admin's configured origin, whatever hostname the request claimed", async () => {
		const person = await newPerson();
		const response = await install.request(
			fromAddress(
				new Request(install.adminUrl("/api/rpc/passwordReset/request"), {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: TEST_ADMIN_ORIGIN,
						"x-forwarded-host": "evil.example",
						forwarded: "host=evil.example",
					},
					body: JSON.stringify({ json: { email: person.email } }),
				}),
				"198.18.0.1",
			),
		);
		expect(response.status).toBe(200);

		const text = (await resetEmailsTo(person.email)).at(-1)?.text ?? "";
		expect(text).toContain(`${TEST_ADMIN_ORIGIN}/reset-password?token=`);
		expect(text).not.toContain("evil.example");
		expect(text).toContain("30 minutes");
	});

	test("finds the person however they write their address", async () => {
		const person = await newPerson();
		await request(`  ${person.email.toUpperCase()} `);
		expect(await resetEmailsTo(person.email)).toHaveLength(1);
	});

	// Review finding: an hourly quota per person counted every request, so anyone who knew the address
	// could use it up and the person never got a link when they asked. Now emails to one person are
	// spaced 5 minutes apart: an outsider delays the person's own link by 5 minutes at most, and the
	// link the outsider's request sent is in the person's inbox meanwhile, working.
	test("an outsider who keeps asking for someone's link delays theirs by 5 minutes at most, and mail to one person stays bounded", async () => {
		const person = await newPerson();
		// The outsider asks every minute for an hour, each time from another address (the worker
		// works each request as it comes).
		for (let minute = 0; minute < 60; minute++) {
			expect(await request(person.email)).toEqual({ ok: true });
			await install.drainJobs();
			await install.clock.advance(MINUTE);
		}
		expect(await resetEmailsTo(person.email)).toHaveLength(12);

		// The person asks right after one more of the outsider's requests: nothing new is sent yet,
		await request(person.email);
		const sent = await resetEmailsTo(person.email);
		expect(sent).toHaveLength(13);
		await request(person.email);
		await request(person.email);
		expect(await resetEmailsTo(person.email)).toHaveLength(13);
		// but the newest email in their inbox opens the reset,
		const newest = new URL(sent.at(-1)?.text?.match(/https?:\/\/\S+/)?.[0] ?? "");
		await install.browser().api.passwordReset.check({ token: tokenOf(newest) });
		// and 5 minutes after it was sent, their own request sends a new one.
		await install.clock.advance(5 * MINUTE);
		await request(person.email);
		expect(await resetEmailsTo(person.email)).toHaveLength(14);
	});

	test("takes at most 5 requests in 15 minutes from one client address", async () => {
		const browser = install.browser({ address: "198.18.0.77" });
		for (let asked = 0; asked < 5; asked++) await request(`someone-${asked}@client.example`, browser);

		await expect(request("someone-else@client.example", browser)).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
			status: 429,
		});
		await install.clock.advance(15 * MINUTE);
		await expect(request("someone-else@client.example", browser)).resolves.toEqual({ ok: true });
	});

	test("counts an IPv6 client by its /64, not by each address of it", async () => {
		for (let asked = 0; asked < 5; asked++) {
			await request(`someone-${asked}@client.example`, install.browser({ address: `2001:db8:5:5::${asked + 1}` }));
		}
		await expect(
			request("someone-else@client.example", install.browser({ address: "2001:db8:5:5:ffff::9" })),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
		await expect(
			request("someone-else@client.example", install.browser({ address: "2001:db8:5:6::1" })),
		).resolves.toEqual({ ok: true });
	});

	test("is in the person's Admin language", async () => {
		const person = await newPerson();
		await person.browser.api.me.updatePreferences({ adminLanguage: "it" });

		await request(person.email);
		await install.drainJobs();
		const email = await install.lastEmailTo(person.email);
		expect(email.subject).toBe("Reimposta la password");
		expect(email.text).toContain("/reset-password?token=");
	});
});

describe("choosing a new password with the link", () => {
	test("works once: the new password signs in, the old one doesn't, and every session of the person ended", async () => {
		const person = await newPerson();
		const elsewhere = await install.signIn(person);
		const link = await linkFor(person.email);
		const visitor = install.browser();

		expect(await visitor.api.passwordReset.check({ token: tokenOf(link) })).toEqual({
			expiresAt: new Date(install.clock.now().getTime() + 30 * MINUTE),
		});
		expect(await visitor.api.passwordReset.complete({ token: tokenOf(link), newPassword: NEW_PASSWORD })).toEqual({
			ok: true,
		});

		// The reset signs nobody in: the person signs in with the new password.
		expect((await visitor.api.session.current()).person).toBeNull();
		expect((await person.browser.api.session.current()).person).toBeNull();
		expect((await elsewhere.api.session.current()).person).toBeNull();
		await expect(install.signIn(person)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
		const signedIn = await install.signIn({ email: person.email, password: NEW_PASSWORD });
		expect((await signedIn.api.session.current()).person?.email).toBe(person.email);

		await expect(install.browser().api.passwordReset.check({ token: tokenOf(link) })).rejects.toMatchObject({
			code: "PASSWORD_RESET_INVALID",
			status: 404,
		});
		await expect(
			install.browser().api.passwordReset.complete({ token: tokenOf(link), newPassword: "another password to use" }),
		).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
		await expect(install.signIn({ email: person.email, password: NEW_PASSWORD })).resolves.toBeDefined();
	});

	test("stops working after 30 minutes", async () => {
		const person = await newPerson();
		const link = await linkFor(person.email);
		await install.clock.advance(30 * MINUTE);

		await expect(
			install.browser().api.passwordReset.complete({ token: tokenOf(link), newPassword: NEW_PASSWORD }),
		).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
		await expect(install.signIn(person)).resolves.toBeDefined();
	});

	test("only the newest link works", async () => {
		const person = await newPerson();
		const first = await linkFor(person.email);
		// Emails to one person are 5 minutes apart.
		await install.clock.advance(5 * MINUTE);
		const second = await linkFor(person.email);
		expect(tokenOf(second)).not.toBe(tokenOf(first));

		await expect(
			install.browser().api.passwordReset.complete({ token: tokenOf(first), newPassword: NEW_PASSWORD }),
		).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
		await install.browser().api.passwordReset.complete({ token: tokenOf(second), newPassword: NEW_PASSWORD });
	});

	test("a made-up token is refused like a used one", async () => {
		await expect(
			install.browser().api.passwordReset.complete({ token: "not-a-token", newPassword: NEW_PASSWORD }),
		).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID", status: 404 });
	});

	test("refuses a password the rules don't allow, and the link still works for a good one", async () => {
		const person = await newPerson();
		const link = await linkFor(person.email);
		const visitor = install.browser();

		await expect(
			visitor.api.passwordReset.complete({ token: tokenOf(link), newPassword: "too short" }),
		).rejects.toMatchObject({ code: "PASSWORD_REFUSED", data: { problem: "too-short" } });

		const leaked = "correct horse battery staple";
		const hash = createHash("sha1").update(leaked).digest("hex").toUpperCase();
		install.http.respond("GET", RANGE, { body: `${hash.slice(5)}:12\r\n` });
		await expect(
			visitor.api.passwordReset.complete({ token: tokenOf(link), newPassword: leaked }),
		).rejects.toMatchObject({ code: "PASSWORD_REFUSED", data: { problem: "leaked" } });
		await expect(install.signIn(person)).resolves.toBeDefined();

		install.http.reset();
		await visitor.api.passwordReset.complete({ token: tokenOf(link), newPassword: NEW_PASSWORD });
		await expect(install.signIn({ email: person.email, password: NEW_PASSWORD })).resolves.toBeDefined();
	});

	test("never removes or skips a second factor, and leaves API tokens as they are", async () => {
		const person = await newPerson();
		const { secret } = await addAuthenticator(install, person.browser, person.password);
		const token = await createApiToken(person.browser, { workspaceId, name: "Deploy" });
		const link = await linkFor(person.email);

		await install.browser().api.passwordReset.complete({ token: tokenOf(link), newPassword: NEW_PASSWORD });

		const first = await install.browser().api.session.signIn({ email: person.email, password: NEW_PASSWORD });
		expect(first).toEqual({ person: null, secondStep: { methods: ["authenticator", "backupCode"] } });
		const signedIn = await signInWithAuthenticator(install, { email: person.email, password: NEW_PASSWORD }, secret);
		expect((await signedIn.api.me.twoFactor.get()).authenticator).not.toBeNull();
		await tokenClient(install, token.secret).api.workspaces.get({ workspaceId });
	});

	test("is recorded in the Audit log as the person's own doing, without the password", async () => {
		const person = await newPerson();
		const link = await linkFor(person.email);
		await install.browser().api.passwordReset.complete({ token: tokenOf(link), newPassword: NEW_PASSWORD });

		const admin = await install.superadmin();
		const entry = (await admin.api.audit.list({ limit: 5 })).entries.find((found) => found.action === "password.reset");
		expect(entry).toMatchObject({
			personId: person.personId,
			via: { kind: "admin" },
			workspaceId: null,
			details: { signedOutSessions: 1, by: "email" },
		});
		expect(JSON.stringify(entry)).not.toContain(NEW_PASSWORD);
	});

	test("lets the person back in from a network their own wrong passwords stopped", async () => {
		const person = await newPerson();
		const address = "198.18.0.99";
		for (let attempts = 0; attempts < 10; attempts++) {
			await install
				.browser({ address })
				.api.session.signIn({ email: person.email, password: "not the right password" })
				.catch(() => undefined);
		}
		await install.clock.advance(MINUTE);
		const link = await linkFor(person.email);

		await install.browser({ address }).api.passwordReset.complete({ token: tokenOf(link), newPassword: NEW_PASSWORD });

		await expect(
			install.browser({ address }).api.session.signIn({ email: person.email, password: NEW_PASSWORD }),
		).resolves.toMatchObject({ person: { email: person.email } });
	});
});

describe("a link asked for before the account was secured", () => {
	// Review finding: someone who got hold of a reset link (a mailbox they could read for a moment)
	// could still use it after the owner changed their password, or after their two-factor
	// authentication was reset because the account may have been taken over.
	test("stops working once the person changes their password while signed in", async () => {
		const person = await newPerson();
		const link = await linkFor(person.email);

		await person.browser.api.session.confirmIdentity({ password: person.password });
		await person.browser.api.me.changePassword({ newPassword: NEW_PASSWORD });

		await expect(install.browser().api.passwordReset.check({ token: tokenOf(link) })).rejects.toMatchObject({
			code: "PASSWORD_RESET_INVALID",
		});
		await expect(
			install
				.browser()
				.api.passwordReset.complete({ token: tokenOf(link), newPassword: "the intruder's own password" }),
		).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
		await expect(install.signIn({ email: person.email, password: NEW_PASSWORD })).resolves.toBeDefined();
	});

	test("stops working once their two-factor authentication is reset", async () => {
		const person = await newPerson();
		await addAuthenticator(install, person.browser, person.password);
		const link = await linkFor(person.email);

		const admin = await install.superadmin();
		await confirmIfAsked(admin, TEST_PASSWORD, () =>
			admin.api.members.resetTwoFactor({ workspaceId, personId: person.personId }),
		);

		await expect(
			install
				.browser()
				.api.passwordReset.complete({ token: tokenOf(link), newPassword: "the intruder's own password" }),
		).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
		await expect(install.signIn(person)).resolves.toBeDefined();
	});
});

describe("changing your own password", () => {
	// Signing other browsers out reads as "whoever had my password is out". A token or AI client made
	// with the account goes on working, so the answer says how many there are (the report's A1-7).
	test("says how many API tokens and AI clients stay active, so the person can revoke them", async () => {
		const person = await newPerson();
		const elsewhere = await install.signIn(person);
		const { secret } = await createApiToken(person.browser, { workspaceId, name: "Deploy" });
		await approveAiClient(install, person.browser, { workspaceId });

		await person.browser.api.session.confirmIdentity({ password: person.password });
		const answer = await person.browser.api.me.changePassword({ newPassword: NEW_PASSWORD });

		expect(answer).toEqual({ signedOutSessions: 1, activeApiTokens: 1, activeAiClients: 1 });
		expect((await elsewhere.api.session.current()).person).toBeNull();
		await tokenClient(install, secret).api.workspaces.get({ workspaceId });
		const admin = await install.superadmin();
		const entry = (await admin.api.audit.list({ limit: 5 })).entries.find(
			(found) => found.action === "password.change",
		);
		expect(entry).toMatchObject({ details: { signedOutSessions: 1, activeApiTokens: 1, activeAiClients: 1 } });
	});
});
