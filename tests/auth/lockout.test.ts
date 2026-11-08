import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";

const MINUTE = 60 * 1000;
const WRONG = "not the right password";

let install: TestInstall;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
});

afterAll(async () => {
	await install.close();
});

async function newPerson(): Promise<TestAccount & { personId: string }> {
	const { account, personId, browser } = await install.createMember({ workspaceId, role: "editor" });
	await browser.api.session.signOut();
	return { ...account, personId };
}

/** Signs in from a new browser (and so a new address each time, as a guesser spread over many would). */
function attempt(account: Pick<TestAccount, "email">, password: string, address?: string) {
	return install.browser(address ? { address } : {}).api.session.signIn({ email: account.email, password });
}

async function failTimes(account: Pick<TestAccount, "email">, times: number) {
	for (let attempts = 0; attempts < times; attempts++) {
		await expect(attempt(account, WRONG)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
	}
}

describe("lockout", () => {
	test("10 wrong passwords in a row lock the account for 15 minutes: even the right password is refused", async () => {
		const person = await newPerson();
		await failTimes(person, 9);

		await expect(attempt(person, WRONG)).rejects.toMatchObject({
			code: "ACCOUNT_LOCKED",
			status: 423,
			data: { retryAfterSeconds: 15 * 60 },
		});
		await install.clock.advance(5 * MINUTE);
		await expect(attempt(person, person.password)).rejects.toMatchObject({
			code: "ACCOUNT_LOCKED",
			data: { retryAfterSeconds: 10 * 60 },
		});
	});

	test("the account unlocks by itself after 15 minutes, and trying while locked doesn't make it longer", async () => {
		const person = await newPerson();
		await failTimes(person, 9);
		await expect(attempt(person, WRONG)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });

		await install.clock.advance(14 * MINUTE);
		await expect(attempt(person, WRONG)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
		await expect(attempt(person, person.password)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
		await install.clock.advance(MINUTE);

		await expect(attempt(person, person.password)).resolves.toMatchObject({ person: { email: person.email } });
	});

	test("after it unlocks, it takes 10 more wrong passwords to lock it again", async () => {
		const person = await newPerson();
		await failTimes(person, 9);
		await expect(attempt(person, WRONG)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
		await install.clock.advance(15 * MINUTE);

		await failTimes(person, 9);
		await expect(attempt(person, WRONG)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
	});

	test("a right password starts the count again: only failures in a row lock", async () => {
		const person = await newPerson();
		await failTimes(person, 9);
		await attempt(person, person.password);

		await failTimes(person, 9);
		await expect(attempt(person, person.password)).resolves.toBeDefined();
	});

	test("the Retry-After header says how long to wait", async () => {
		const person = await newPerson();
		await failTimes(person, 10 - 1);
		await expect(attempt(person, WRONG)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });

		const response = await install.request(install.adminUrl("/api/rpc/session/signIn"), {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://admin.test" },
			body: JSON.stringify({ json: { email: person.email, password: person.password } }),
		});

		expect(response.status).toBe(423);
		expect(response.headers.get("retry-after")).toBe(String(15 * 60));
	});

	test("the person is emailed, once, in their Admin language", async () => {
		const person = await newPerson();
		await failTimes(person, 9);
		await expect(attempt(person, WRONG)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
		await expect(attempt(person, WRONG)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });

		const email = await install.lastEmailTo(person.email);
		expect(email.subject).toBe("Your account is locked for a while");
		expect(email.text).toContain("After 10 failed attempts to sign in");
		expect(email.text).toContain("locked for 15 minutes");
		const emails = install.logs.filter((entry) => (entry.email as { to?: string } | undefined)?.to === person.email);
		expect(emails.map((entry) => (entry.email as { subject: string }).subject)).toEqual([
			"Your account is locked for a while",
		]);
	});

	test("is recorded in the Audit log, with where the last attempt came from", async () => {
		const person = await newPerson();
		await failTimes(person, 9);
		await expect(attempt(person, WRONG, "203.0.113.66")).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });

		const admin = await install.superadmin();
		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "account.lock",
			personId: null,
			workspaceId: null,
			details: {
				personId: person.personId,
				email: person.email,
				failedAttempts: 10,
				lockedUntil: new Date(install.clock.now().getTime() + 15 * MINUTE).toISOString(),
				clientAddress: "203.0.113.66",
			},
		});
	});

	test("wrong passwords count when confirming who you are, too; a signed-in session stays signed in", async () => {
		const person = await newPerson();
		const browser = await install.signIn(person);
		for (let attempts = 0; attempts < 9; attempts++) {
			await expect(browser.api.session.confirmIdentity({ password: WRONG })).rejects.toMatchObject({
				code: "INVALID_CREDENTIALS",
			});
		}
		// Past the per-address limit's minute: the count of wrong passwords goes on regardless.
		await install.clock.advance(MINUTE);

		await expect(browser.api.session.confirmIdentity({ password: WRONG })).rejects.toMatchObject({
			code: "ACCOUNT_LOCKED",
		});
		await expect(browser.api.session.confirmIdentity({ password: person.password })).rejects.toMatchObject({
			code: "ACCOUNT_LOCKED",
		});
		expect(await browser.api.session.current()).toMatchObject({ person: { email: person.email } });
		await expect(attempt(person, person.password)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
	});

	test("an address nobody signs in with never locks, so the answer never tells which addresses exist", async () => {
		await failTimes({ email: "nobody@client.example" }, 12);
	});
});
