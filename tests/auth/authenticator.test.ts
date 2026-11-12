// An authenticator app (TOTP) as a second factor: adding it, signing in with its codes or a backup
// code, and removing it. Codes are made in the test from the secret the admin shows, as an app would.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";
import {
	addAuthenticator,
	confirmIfAsked,
	signInWithAuthenticator,
	TOTP_STEP_MS,
	totpCode,
} from "../harness/two-factor.ts";

const MINUTE = 60_000;

let install: TestInstall;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme")).id;
});

afterAll(async () => {
	await install.close();
});

async function newPerson() {
	const member = await install.createMember({ workspaceId, role: "editor" });
	return { ...member, account: member.account as TestAccount };
}

/** A person with an authenticator app, signed out everywhere. */
async function personWithAuthenticator() {
	const person = await newPerson();
	const added = await addAuthenticator(install, person.browser);
	await person.browser.api.session.signOut();
	return { ...person, ...added };
}

function signInFirstStep(account: Pick<TestAccount, "email" | "password">) {
	const browser = install.browser();
	return { browser, answer: browser.api.session.signIn({ email: account.email, password: account.password }) };
}

describe("adding an authenticator app", () => {
	// The report's "Sloppy code": the secret was read once to check the code and again to save it, so
	// starting over at that moment (a second tab, a double click) saved a secret the app doesn't hold,
	// and the person was locked out of their own second step.
	test("the secret that is saved is the one the code was checked against, even when adding is started again at that moment", async () => {
		for (let round = 0; round < 20; round++) {
			const { browser, account } = await newPerson();
			const { secret } = await browser.api.me.twoFactor.startAuthenticator();
			const [confirmed] = await Promise.allSettled([
				browser.api.me.twoFactor.confirmAuthenticator({ code: totpCode(secret, install.clock.now()) }),
				browser.api.me.twoFactor.startAuthenticator(),
			]);
			if (confirmed.status !== "fulfilled") continue;

			// The app that was confirmed signs in.
			const signedIn = await signInWithAuthenticator(install, account, secret);
			expect({ round, person: (await signedIn.api.session.current()).person?.email }).toEqual({
				round,
				person: account.email,
			});
		}
	});

	test("shows a secret and its QR code's address, and adds the app once a code from it is right", async () => {
		const { browser, account } = await newPerson();

		const { secret, uri } = await browser.api.me.twoFactor.startAuthenticator();
		expect(secret).toMatch(/^[A-Z2-7]{32}$/);
		const address = new URL(uri);
		expect(address.protocol).toBe("otpauth:");
		expect(address.host + decodeURIComponent(address.pathname)).toBe(`totp/WebCraft:${account.email}`);
		expect(Object.fromEntries(address.searchParams)).toEqual({
			secret,
			issuer: "WebCraft",
			algorithm: "SHA1",
			digits: "6",
			period: "30",
		});
		expect((await browser.api.me.twoFactor.get()).authenticator).toBeNull();

		const { backupCodes } = await browser.api.me.twoFactor.confirmAuthenticator({
			code: totpCode(secret, install.clock.now()),
		});

		expect(backupCodes).toHaveLength(10);
		expect(new Set(backupCodes).size).toBe(10);
		for (const code of backupCodes ?? []) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
		expect(await browser.api.me.twoFactor.get()).toMatchObject({
			authenticator: { addedAt: install.clock.now() },
			passkeys: [],
			backupCodes: { left: 10 },
		});
	});

	test("refuses a wrong code and adds nothing", async () => {
		const { browser } = await newPerson();
		const { secret } = await browser.api.me.twoFactor.startAuthenticator();

		await expect(
			browser.api.me.twoFactor.confirmAuthenticator({ code: totpCode(secret, install.clock.now(), 5) }),
		).rejects.toMatchObject({ code: "TWO_FACTOR_CODE_INVALID", status: 400 });
		await expect(browser.api.me.twoFactor.confirmAuthenticator({ code: "12345" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect((await browser.api.me.twoFactor.get()).authenticator).toBeNull();
	});

	test("refuses a code when no app is being added", async () => {
		const { browser } = await newPerson();

		await expect(browser.api.me.twoFactor.confirmAuthenticator({ code: "123456" })).rejects.toMatchObject({
			code: "TWO_FACTOR_CODE_INVALID",
		});
	});

	test("keeps the secret and the backup codes nowhere in the database as they are", async () => {
		const { browser } = await newPerson();
		const { secret, backupCodes } = await addAuthenticator(install, browser);

		expect(await install.tablesHolding(secret)).toEqual([]);
		for (const code of backupCodes) expect(await install.tablesHolding(code)).toEqual([]);
	});

	test("is a Sensitive action", async () => {
		const { browser, account } = await newPerson();
		await install.clock.advance(11 * MINUTE);

		await expect(browser.api.me.twoFactor.startAuthenticator()).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
			data: { action: "twoFactor.change" },
		});
		await browser.api.session.confirmIdentity({ password: account.password });
		const { secret } = await browser.api.me.twoFactor.startAuthenticator();
		await install.clock.advance(11 * MINUTE);
		await expect(
			browser.api.me.twoFactor.confirmAuthenticator({ code: totpCode(secret, install.clock.now()) }),
		).rejects.toMatchObject({ code: "IDENTITY_CHECK_REQUIRED" });
	});

	test("emails the person, signs out their other sessions and is in the Audit log", async () => {
		const { browser, account, personId } = await newPerson();
		const laptop = await install.signIn(account);

		await addAuthenticator(install, browser);

		expect((await install.lastEmailTo(account.email)).subject).toBe("An authenticator app was added to your account");
		expect((await laptop.api.session.current()).person).toBeNull();
		expect((await browser.api.session.current()).person?.id).toBe(personId);
		const admin = await install.superadmin();
		const { entries } = await admin.api.audit.list();
		expect(entries.find((entry) => entry.action === "twoFactor.add" && entry.personId === personId)).toMatchObject({
			via: { kind: "admin" },
			workspaceId: null,
			details: { method: "authenticator", signedOutSessions: 1 },
		});
	});
});

describe("signing in with an authenticator app", () => {
	test("the right password alone starts no session: it asks for the second step", async () => {
		const { account } = await personWithAuthenticator();
		const { browser, answer } = signInFirstStep(account);

		expect(await answer).toEqual({ person: null, secondStep: { methods: ["authenticator", "backupCode"] } });
		expect((await browser.api.session.current()).person).toBeNull();
		await expect(browser.api.me.twoFactor.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	test("a code from the app finishes signing in", async () => {
		const { account, personId, secret } = await personWithAuthenticator();
		await install.clock.advance(TOTP_STEP_MS);
		const { browser, answer } = signInFirstStep(account);
		await answer;

		const { person } = await browser.api.session.secondStep({
			method: "authenticator",
			code: totpCode(secret, install.clock.now()),
		});

		expect(person.id).toBe(personId);
		expect((await browser.api.session.current()).person?.id).toBe(personId);
	});

	test("accepts the code of the step before or after, for a clock a little off, but not further", async () => {
		const { account, secret } = await personWithAuthenticator();

		for (const offset of [-1, 1]) {
			await install.clock.advance(3 * TOTP_STEP_MS);
			const { browser, answer } = signInFirstStep(account);
			await answer;
			await browser.api.session.secondStep({
				method: "authenticator",
				code: totpCode(secret, install.clock.now(), offset),
			});
			expect((await browser.api.session.current()).person).not.toBeNull();
		}
		for (const offset of [-2, 2]) {
			await install.clock.advance(3 * TOTP_STEP_MS);
			const { browser, answer } = signInFirstStep(account);
			await answer;
			await expect(
				browser.api.session.secondStep({
					method: "authenticator",
					code: totpCode(secret, install.clock.now(), offset),
				}),
			).rejects.toMatchObject({ code: "TWO_FACTOR_CODE_INVALID", status: 401 });
		}
	});

	test("never accepts the same code twice, nor an older one once a newer was used", async () => {
		const { account, secret } = await personWithAuthenticator();
		await install.clock.advance(TOTP_STEP_MS);
		const code = totpCode(secret, install.clock.now());
		const older = totpCode(secret, install.clock.now(), -1);
		const first = signInFirstStep(account);
		await first.answer;
		await first.browser.api.session.secondStep({ method: "authenticator", code });

		for (const reused of [code, older]) {
			const again = signInFirstStep(account);
			await again.answer;
			await expect(
				again.browser.api.session.secondStep({ method: "authenticator", code: reused }),
			).rejects.toMatchObject({
				code: "TWO_FACTOR_CODE_INVALID",
			});
		}
	});

	test("the second step needs the right password first, in the same browser, within 5 minutes", async () => {
		const { account, secret } = await personWithAuthenticator();
		await install.clock.advance(TOTP_STEP_MS);

		await expect(
			install
				.browser()
				.api.session.secondStep({ method: "authenticator", code: totpCode(secret, install.clock.now()) }),
		).rejects.toMatchObject({ code: "SIGN_IN_EXPIRED", status: 401 });

		const wrong = install.browser();
		await expect(
			wrong.api.session.signIn({ email: account.email, password: "not the right password" }),
		).rejects.toMatchObject({
			code: "INVALID_CREDENTIALS",
		});
		await expect(
			wrong.api.session.secondStep({ method: "authenticator", code: totpCode(secret, install.clock.now()) }),
		).rejects.toMatchObject({ code: "SIGN_IN_EXPIRED" });

		const slow = signInFirstStep(account);
		await slow.answer;
		await install.clock.advance(5 * MINUTE + 1000);
		await expect(
			slow.browser.api.session.secondStep({ method: "authenticator", code: totpCode(secret, install.clock.now()) }),
		).rejects.toMatchObject({ code: "SIGN_IN_EXPIRED" });
	});

	test("10 wrong codes in a row lock the second step for 15 minutes, and a right password in between doesn't start the count again", async () => {
		const { account, secret } = await personWithAuthenticator();
		const wrongCode = () => totpCode(secret, install.clock.now(), 7);

		for (let round = 0; round < 2; round++) {
			const { browser, answer } = signInFirstStep(account);
			await answer;
			const tries = round === 0 ? 5 : 4;
			for (let attempt = 0; attempt < tries; attempt++) {
				await expect(
					browser.api.session.secondStep({ method: "authenticator", code: wrongCode() }),
				).rejects.toMatchObject({
					code: "TWO_FACTOR_CODE_INVALID",
				});
			}
			if (round === 1) {
				await expect(
					browser.api.session.secondStep({ method: "authenticator", code: wrongCode() }),
				).rejects.toMatchObject({
					code: "ACCOUNT_LOCKED",
					status: 423,
				});
			}
		}

		expect((await install.lastEmailTo(account.email)).subject).toContain("Too many failed attempts");
		// The password still opens the second step (whoever got this far knows it); no code is checked.
		await install.clock.advance(TOTP_STEP_MS);
		const locked = signInFirstStep(account);
		await locked.answer;
		await expect(
			locked.browser.api.session.secondStep({ method: "authenticator", code: totpCode(secret, install.clock.now()) }),
		).rejects.toMatchObject({ code: "ACCOUNT_LOCKED", status: 423 });
		await install.clock.advance(15 * MINUTE);
		expect(
			(await signInWithAuthenticator(install, account, secret).then((b) => b.api.session.current())).person,
		).not.toBeNull();
	});

	test("the second step is rate-limited per client address like the other sign-in endpoints", async () => {
		const { account, secret } = await personWithAuthenticator();
		const browser = install.browser();
		await browser.api.session.signIn({ email: account.email, password: account.password });

		const answers: string[] = [];
		for (let attempt = 0; attempt < 10; attempt++) {
			answers.push(
				await browser.api.session
					.secondStep({ method: "authenticator", code: totpCode(secret, install.clock.now(), 9) })
					.then(
						() => "ok",
						(error: { code: string }) => error.code,
					),
			);
		}
		expect(answers.at(-1)).toBe("TOO_MANY_REQUESTS");
		await install.clock.advance(MINUTE);
	});
});

describe("backup codes", () => {
	test("each signs in once, in any case and with or without its dash", async () => {
		const { account, backupCodes } = await personWithAuthenticator();
		const [first = "", second = ""] = backupCodes;

		const one = signInFirstStep(account);
		await one.answer;
		await one.browser.api.session.secondStep({ method: "backupCode", code: ` ${first.toUpperCase()} ` });
		expect((await one.browser.api.session.current()).person).not.toBeNull();

		const two = signInFirstStep(account);
		await two.answer;
		await two.browser.api.session.secondStep({ method: "backupCode", code: second.replace("-", "") });
		expect(await two.browser.api.me.twoFactor.get()).toMatchObject({ backupCodes: { left: 8 } });

		const again = signInFirstStep(account);
		await again.answer;
		await expect(again.browser.api.session.secondStep({ method: "backupCode", code: first })).rejects.toMatchObject({
			code: "TWO_FACTOR_CODE_INVALID",
		});
	});

	test("making new ones shows 10 new codes once and ends the old ones", async () => {
		const { account, backupCodes, secret } = await personWithAuthenticator();
		const browser = await signInWithAuthenticator(install, account, secret);

		const { backupCodes: fresh } = await confirmIfAsked(browser, account.password, () =>
			browser.api.me.twoFactor.regenerateBackupCodes(),
		);

		expect(fresh).toHaveLength(10);
		expect(fresh.some((code) => backupCodes.includes(code))).toBe(false);
		const old = signInFirstStep(account);
		await old.answer;
		await expect(
			old.browser.api.session.secondStep({ method: "backupCode", code: backupCodes[0] ?? "" }),
		).rejects.toMatchObject({
			code: "TWO_FACTOR_CODE_INVALID",
		});
		await old.browser.api.session.secondStep({ method: "backupCode", code: fresh[0] ?? "" });
		expect((await old.browser.api.session.current()).person).not.toBeNull();
	});
});

describe("removing the authenticator app", () => {
	test("emails the person, signs out their other sessions, and signing in needs the password only", async () => {
		const { account, secret, personId } = await personWithAuthenticator();
		const browser = await signInWithAuthenticator(install, account, secret);
		const phone = await signInWithAuthenticator(install, account, secret);

		await confirmIfAsked(browser, account.password, () => browser.api.me.twoFactor.removeAuthenticator());

		expect((await install.lastEmailTo(account.email)).subject).toBe(
			"An authenticator app was removed from your account",
		);
		expect((await phone.api.session.current()).person).toBeNull();
		expect(await browser.api.me.twoFactor.get()).toMatchObject({ authenticator: null, backupCodes: { left: 0 } });
		const { answer } = signInFirstStep(account);
		expect(await answer).toMatchObject({ person: { id: personId }, secondStep: null });
	});

	test("is a Sensitive action", async () => {
		const { account, secret } = await personWithAuthenticator();
		const browser = await signInWithAuthenticator(install, account, secret);
		await install.clock.advance(11 * MINUTE);

		await expect(browser.api.me.twoFactor.removeAuthenticator()).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
			data: { action: "twoFactor.change" },
		});
	});
});
