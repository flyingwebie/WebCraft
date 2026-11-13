// Wrong passwords stop the guessing, never the person: sign-in with a password is stopped for the
// network the wrong ones came from, and for networks the person never signed in from once many
// networks guess together. Passkeys, open sessions, API tokens and AI clients are never stopped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import type { TestBrowser } from "../harness/browser.ts";
import { createTestInstall, fromAddress, type TestAccount, type TestInstall } from "../harness/index.ts";
import { approveAiClient, connectMcp } from "../harness/mcp.ts";
import { type SoftwareAuthenticator, softwareAuthenticator } from "../harness/passkeys.ts";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const WRONG = "not the right password";
const LOCKED_SUBJECT = "Too many failed attempts to sign in to your account";

let install: TestInstall;
let workspaceId: string;
let networks = 0;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
});

afterAll(async () => {
	await install.close();
});

/** A client address no other test uses: a guesser's, or a person's own. */
function newAddress(): string {
	const n = ++networks;
	return `198.51.${(n >> 8) & 255}.${n & 255}`;
}

async function newPerson(): Promise<TestAccount & { personId: string; browser: TestBrowser }> {
	const { account, personId, browser } = await install.createMember({ workspaceId, role: "owner" });
	return { ...account, personId, browser };
}

function attempt(account: Pick<TestAccount, "email">, password: string, address: string) {
	return install.browser({ address }).api.session.signIn({ email: account.email, password });
}

/** `times` wrong passwords for the account from one address (at most 10: the address's limit a minute). */
async function failFrom(address: string, account: Pick<TestAccount, "email">, times = 10) {
	for (let attempts = 0; attempts < times; attempts++) {
		await expect(attempt(account, WRONG, address)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
	}
}

async function addPasskey(browser: TestBrowser, device: SoftwareAuthenticator) {
	const { options } = await browser.api.me.twoFactor.passkeyOptions();
	return browser.api.me.twoFactor.addPasskey({ credential: await device.create(options), name: "Laptop" });
}

function lockEmailsTo(address: string): number {
	const subjects = install.logs
		.map((entry) => entry.email as { to?: string; subject?: string } | undefined)
		.filter((email) => email?.to === address)
		.map((email) => email?.subject);
	return subjects.filter((subject) => subject === LOCKED_SUBJECT).length;
}

describe("wrong passwords from an outsider", () => {
	test("never keep the person out: they sign in from their own network", async () => {
		const person = await newPerson();
		await failFrom(newAddress(), person);

		await expect(attempt(person, person.password, newAddress())).resolves.toMatchObject({
			person: { email: person.email },
		});
	});

	test("don't stop the person's passkey, not even from the guesser's own network", async () => {
		const person = await newPerson();
		const device = softwareAuthenticator();
		await addPasskey(person.browser, device);
		const guesser = newAddress();
		await failFrom(guesser, person);
		await install.clock.advance(MINUTE);

		const browser = install.browser({ address: guesser });
		const { options } = await browser.api.session.passkeyOptions();
		const answer = await browser.api.session.signInWithPasskey({ credential: await device.get(options) });
		expect(answer.person.email).toBe(person.email);
	});

	test("don't stop the person's API tokens or AI clients", async () => {
		const person = await newPerson();
		const { secret } = await createApiToken(person.browser, { workspaceId, name: "Deploy" });
		const client = await approveAiClient(install, person.browser, { workspaceId });
		await failFrom(newAddress(), person);

		const answer = await tokenClient(install, secret).request("workspaces/get", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workspaceId }),
		});
		expect(answer.status).toBe(200);
		await (await connectMcp(install, client.accessToken)).close();
	});

	test("don't stop the person confirming who they are in a browser they are signed in with", async () => {
		const person = await newPerson();
		// From the very network the person is on (a shared office address), a minute after they joined.
		await install.clock.advance(MINUTE);
		await failFrom(person.browser.address ?? "", person);
		await install.clock.advance(MINUTE);

		await expect(person.browser.api.session.confirmIdentity({ password: person.password })).resolves.toEqual({
			ok: true,
		});
	});
});

describe("wrong passwords from one network", () => {
	test("10 in a row stop sign-in from it for 15 minutes: even the right password is refused", async () => {
		const person = await newPerson();
		const address = newAddress();
		await failFrom(address, person);

		await install.clock.advance(5 * MINUTE);
		await expect(attempt(person, person.password, address)).rejects.toMatchObject({
			code: "INVALID_CREDENTIALS",
			status: 401,
		});
	});

	// Signing in never says a network is stopped: that would tell a guesser the address has an
	// account. The person learns it from the email.
	test("a stopped network is answered exactly like an address with no account", async () => {
		const person = await newPerson();
		const nobody = { email: "nobody-here@client.example" };
		const addresses = [newAddress(), newAddress()];
		await failFrom(addresses[0] ?? "", person);
		await failFrom(addresses[1] ?? "", nobody);
		await install.clock.advance(MINUTE);

		const answers = await Promise.all(
			[person, nobody].map((account, index) =>
				install.request(
					fromAddress(
						new Request(install.adminUrl("/api/rpc/session/signIn"), {
							method: "POST",
							headers: { "content-type": "application/json", origin: "https://admin.test" },
							body: JSON.stringify({ json: { email: account.email, password: WRONG } }),
						}),
						addresses[index] ?? null,
					),
				),
			),
		);
		const [stopped, unknown] = await Promise.all(
			answers.map(async (response) => ({
				status: response.status,
				retryAfter: response.headers.get("retry-after"),
				body: await response.json(),
			})),
		);
		expect(stopped).toEqual(unknown);
		expect(stopped?.status).toBe(401);
	});

	test("it opens again by itself after 15 minutes, and trying meanwhile doesn't make it longer", async () => {
		const person = await newPerson();
		const address = newAddress();
		await failFrom(address, person);

		await install.clock.advance(14 * MINUTE);
		await failFrom(address, person, 1);
		await expect(attempt(person, person.password, address)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
		await install.clock.advance(MINUTE);

		await expect(attempt(person, person.password, address)).resolves.toMatchObject({
			person: { email: person.email },
		});
	});

	test("a right password starts the count again: only failures in a row count", async () => {
		const person = await newPerson();
		const address = newAddress();
		await failFrom(address, person, 9);
		await attempt(person, person.password, address);
		await install.clock.advance(MINUTE);

		await failFrom(address, person, 9);
		await expect(attempt(person, person.password, address)).resolves.toBeDefined();
	});

	test("wrong passwords days apart aren't in a row: the count of a network nobody tried from for a day is forgotten", async () => {
		const person = await newPerson();
		const address = newAddress();
		await failFrom(address, person, 9);

		await install.clock.advance(2 * DAY);
		const drained = await install.drainJobs({ only: ["sign-in-counters.purge"] });
		expect(drained.failed).toEqual([]);
		expect(drained.completed.map((job) => job.name)).toContain("sign-in-counters.purge");

		await failFrom(address, person, 9);
		await expect(attempt(person, person.password, address)).resolves.toMatchObject({
			person: { email: person.email },
		});
	});

	test("the addresses of one IPv6 /64 are one network", async () => {
		const person = await newPerson();
		await failFrom("2001:db8:77:1::a", person, 5);
		await failFrom("2001:db8:77:1:ffff::b", person, 5);
		// The auth endpoints' own limit counts the /64 as one client too: its minute passes first.
		await install.clock.advance(MINUTE);

		await expect(attempt(person, person.password, "2001:db8:77:1::c")).rejects.toMatchObject({
			code: "INVALID_CREDENTIALS",
		});
		await expect(attempt(person, person.password, "2001:db8:77:2::a")).resolves.toMatchObject({
			person: { email: person.email },
		});
	});

	test("the person is told by email, in their Admin language, at most once a day", async () => {
		const person = await newPerson();
		const address = newAddress();
		await failFrom(address, person);

		const email = await install.lastEmailTo(person.email);
		expect(email.subject).toBe(LOCKED_SUBJECT);
		expect(email.text).toContain("After 10 wrong passwords or codes");
		expect(email.text).toContain("15 minutes");
		expect(email.text).toContain("passkey");

		// The same network again, and another one: the guesser can't fill the person's inbox.
		await install.clock.advance(16 * MINUTE);
		await failFrom(address, person);
		await failFrom(newAddress(), person);
		await install.lastEmailTo(person.email);
		expect(lockEmailsTo(person.email)).toBe(1);

		await install.clock.advance(DAY);
		await failFrom(address, person);
		await install.lastEmailTo(person.email);
		expect(lockEmailsTo(person.email)).toBe(2);
	});

	test("is recorded in the Audit log, with where the last attempt came from", async () => {
		const person = await newPerson();
		const address = newAddress();
		await failFrom(address, person);

		const admin = await install.superadmin();
		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "account.lock",
			personId: null,
			workspaceId: null,
			details: {
				personId: person.personId,
				email: person.email,
				scope: "network",
				failedAttempts: 10,
				lockedUntil: new Date(install.clock.now().getTime() + 15 * MINUTE).toISOString(),
				clientAddress: address,
			},
		});
	});

	test("an address nobody signs in with is never stopped, so the answer never tells which addresses exist", async () => {
		const address = newAddress();
		await failFrom(address, { email: "nobody@client.example" });
		await install.clock.advance(MINUTE);
		await failFrom(address, { email: "nobody@client.example" }, 2);
	});
});

describe("wrong passwords from many networks", () => {
	test("after 50 in a row, a password is refused for 15 minutes from networks the person never signed in from, and still works from theirs", async () => {
		const person = await newPerson();
		const home = newAddress();
		await (await install.signIn(person, { address: home })).api.session.signOut();

		for (let guesser = 0; guesser < 50; guesser++) await failFrom(newAddress(), person, 1);

		const elsewhere = newAddress();
		await expect(attempt(person, person.password, elsewhere)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
		await expect(attempt(person, person.password, home)).resolves.toMatchObject({ person: { email: person.email } });

		await install.clock.advance(15 * MINUTE);
		await expect(attempt(person, person.password, newAddress())).resolves.toMatchObject({
			person: { email: person.email },
		});
	});
});

describe("wrong passwords confirming who you are", () => {
	test("10 in a row stop it in that session for 15 minutes; the session stays signed in, and signing in elsewhere still works", async () => {
		const person = await newPerson();
		const browser = person.browser;
		for (let attempts = 0; attempts < 9; attempts++) {
			await expect(browser.api.session.confirmIdentity({ password: WRONG })).rejects.toMatchObject({
				code: "INVALID_CREDENTIALS",
			});
		}
		// Past the per-address limit's minute: the count of wrong passwords goes on regardless.
		await install.clock.advance(MINUTE);

		await expect(browser.api.session.confirmIdentity({ password: WRONG })).rejects.toMatchObject({
			code: "ACCOUNT_LOCKED",
			status: 423,
		});
		await expect(browser.api.session.confirmIdentity({ password: person.password })).rejects.toMatchObject({
			code: "ACCOUNT_LOCKED",
		});
		expect(await browser.api.session.current()).toMatchObject({ person: { email: person.email } });
		await expect(attempt(person, person.password, newAddress())).resolves.toMatchObject({
			person: { email: person.email },
		});

		await install.clock.advance(15 * MINUTE);
		await expect(browser.api.session.confirmIdentity({ password: person.password })).resolves.toEqual({ ok: true });
	});
});
