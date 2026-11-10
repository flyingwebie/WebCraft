// Passkeys: adding one (with the admin's hostname as the relying party), signing in with it alone
// (it counts as both factors) or as the second step, confirming who you are with it, and removing it.
// A software authenticator in the test answers the ceremonies as a device would through a browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestBrowser } from "../harness/browser.ts";
import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";
import {
	type PasskeyAlgorithm,
	type SoftwareAuthenticator,
	softwareAuthenticator,
	TEST_RP_ID,
} from "../harness/passkeys.ts";
import { addAuthenticator, confirmIfAsked, signInWithAuthenticator, totpCode } from "../harness/two-factor.ts";

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

/** Adds a passkey from `device` to the browser's account, as the admin's "Add a passkey" does. */
async function addPasskey(browser: TestBrowser, device: SoftwareAuthenticator, name = "Work laptop") {
	const { options } = await browser.api.me.twoFactor.passkeyOptions();
	const credential = await device.create(options);
	return browser.api.me.twoFactor.addPasskey({ credential, name });
}

/** A person with a passkey on `device`, signed out. */
async function personWithPasskey(algorithm: PasskeyAlgorithm = "ES256") {
	const person = await newPerson();
	const device = softwareAuthenticator({ algorithm });
	const added = await addPasskey(person.browser, device);
	await person.browser.api.session.signOut();
	return { ...person, device, backupCodes: added.backupCodes ?? [] };
}

/** Signs in with a passkey alone, from a new browser. */
async function signInWithPasskey(device: SoftwareAuthenticator, tamper = {}) {
	const browser = install.browser();
	const { options } = await browser.api.session.passkeyOptions();
	const credential = await device.get(options, tamper);
	const answer = await browser.api.session.signInWithPasskey({ credential });
	return { browser, answer };
}

describe("adding a passkey", () => {
	test("asks the device for a passkey for the admin's hostname, verified by the person, then lists it", async () => {
		const { browser, account, personId } = await newPerson();

		const { options } = await browser.api.me.twoFactor.passkeyOptions();
		expect(options).toMatchObject({
			rp: { id: TEST_RP_ID, name: "WebCraft" },
			user: { name: account.email, displayName: account.name },
			authenticatorSelection: { residentKey: "required", userVerification: "required" },
			attestation: "none",
			excludeCredentials: [],
		});
		expect(options.pubKeyCredParams.map((param) => param.alg)).toEqual([-7, -8, -257]);
		expect(options.user.id).not.toContain(account.email);

		const device = softwareAuthenticator();
		const credential = await device.create(options);
		const { passkey, backupCodes } = await browser.api.me.twoFactor.addPasskey({ credential, name: "  Work laptop " });

		expect(passkey).toMatchObject({
			name: "Work laptop",
			addedAt: install.clock.now(),
			lastUsedAt: null,
			synced: true,
		});
		expect(backupCodes).toHaveLength(10);
		expect((await browser.api.me.twoFactor.get()).passkeys).toEqual([passkey]);
		expect((await install.lastEmailTo(account.email)).subject).toBe("A passkey was added to your account");
		const admin = await install.superadmin();
		const entry = (await admin.api.audit.list()).entries.find(
			(found) => found.action === "twoFactor.add" && found.personId === personId,
		);
		expect(entry?.details).toMatchObject({ method: "passkey", name: "Work laptop" });
	});

	test("a second passkey gets no new backup codes, and the device can't add the same one twice", async () => {
		const { browser } = await newPerson();
		const device = softwareAuthenticator();
		await addPasskey(browser, device);

		const { options } = await browser.api.me.twoFactor.passkeyOptions();
		expect(options.excludeCredentials).toEqual([
			{ id: device.credentialIds[0] ?? "", type: "public-key", transports: ["internal", "hybrid"] },
		]);
		await expect(device.create(options)).rejects.toThrow("InvalidStateError");

		// Passkeys are listed oldest first: the second is added a minute later.
		await install.clock.advance(60_000);
		const phone = softwareAuthenticator({ algorithm: "EdDSA" });
		const second = await addPasskey(browser, phone, "Phone");
		expect(second.backupCodes).toBeNull();
		expect((await browser.api.me.twoFactor.get()).passkeys.map((passkey) => passkey.name)).toEqual([
			"Work laptop",
			"Phone",
		]);
	});

	test("refuses a passkey for another hostname, from another page, without user verification, or for another challenge", async () => {
		const { browser } = await newPerson();
		const device = softwareAuthenticator();
		const tampered = [
			{ rpId: "shop.sites.test" },
			{ origin: "https://shop.sites.test" },
			{ origin: "https://admin.test.evil.example" },
			{ noUserVerification: true },
			{ challenge: "bm90IHRoZSBjaGFsbGVuZ2U" },
			{ type: "webauthn.get" },
		];
		for (const tamper of tampered) {
			const { options } = await browser.api.me.twoFactor.passkeyOptions();
			const credential = await device.create(options, tamper);
			await expect(browser.api.me.twoFactor.addPasskey({ credential, name: "Laptop" })).rejects.toMatchObject({
				code: "PASSKEY_INVALID",
				status: 400,
			});
		}
		expect((await browser.api.me.twoFactor.get()).passkeys).toEqual([]);
	});

	test("each challenge works once", async () => {
		const { browser } = await newPerson();
		const { options } = await browser.api.me.twoFactor.passkeyOptions();
		const first = await softwareAuthenticator().create(options);
		await browser.api.me.twoFactor.addPasskey({ credential: first, name: "One" });

		const second = await softwareAuthenticator().create(options);
		await expect(browser.api.me.twoFactor.addPasskey({ credential: second, name: "Two" })).rejects.toMatchObject({
			code: "PASSKEY_INVALID",
		});
	});

	test("is a Sensitive action, and signs out the person's other sessions", async () => {
		const { browser, account } = await newPerson();
		const laptop = await install.signIn(account);
		await install.clock.advance(11 * MINUTE);

		await expect(browser.api.me.twoFactor.passkeyOptions()).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
			data: { action: "twoFactor.change" },
		});
		await browser.api.session.confirmIdentity({ password: account.password });
		await addPasskey(browser, softwareAuthenticator());
		expect((await laptop.api.session.current()).person).toBeNull();
	});
});

describe("signing in with a passkey", () => {
	for (const algorithm of ["ES256", "EdDSA", "RS256"] as const) {
		test(`a passkey alone signs in: it counts as both factors (${algorithm})`, async () => {
			const { device, personId } = await personWithPasskey(algorithm);

			const { browser, answer } = await signInWithPasskey(device);

			expect(answer.person.id).toBe(personId);
			expect((await browser.api.session.current()).person?.id).toBe(personId);
			expect((await browser.api.me.twoFactor.get()).passkeys[0]?.lastUsedAt).toEqual(install.clock.now());
		});
	}

	test("the sign-in options name no account: the device offers the person's own passkey", async () => {
		const options = (await install.browser().api.session.passkeyOptions()).options;
		expect(options).toMatchObject({ rpId: TEST_RP_ID, userVerification: "required", allowCredentials: [] });
		expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	test("a password first makes the passkey the second step, and only that person's passkeys are asked for", async () => {
		const { device, account, personId } = await personWithPasskey();
		const other = await personWithPasskey();
		const browser = install.browser();

		expect(await browser.api.session.signIn({ email: account.email, password: account.password })).toEqual({
			person: null,
			secondStep: { methods: ["backupCode", "passkey"] },
		});
		const { options } = await browser.api.session.passkeyOptions();
		expect(options.allowCredentials).toEqual([
			{ id: device.credentialIds[0] ?? "", type: "public-key", transports: ["internal", "hybrid"] },
		]);

		await expect(
			browser.api.session.signInWithPasskey({
				credential: await other.device.get({ ...options, allowCredentials: [] }),
			}),
		).rejects.toMatchObject({ code: "PASSKEY_INVALID", status: 401 });
		const { options: again } = await browser.api.session.passkeyOptions();
		const { person } = await browser.api.session.signInWithPasskey({ credential: await device.get(again) });
		expect(person.id).toBe(personId);
	});

	test("refuses a signature from another key, another page or hostname, no user verification, a used challenge", async () => {
		const { device } = await personWithPasskey();
		const tampered = [
			{ wrongKey: true },
			{ origin: "https://shop.sites.test" },
			{ rpId: "shop.sites.test" },
			{ noUserVerification: true },
			{ type: "webauthn.create" },
		];
		for (const tamper of tampered) {
			await expect(signInWithPasskey(device, tamper)).rejects.toMatchObject({ code: "PASSKEY_INVALID", status: 401 });
		}

		const browser = install.browser();
		const { options } = await browser.api.session.passkeyOptions();
		const credential = await device.get(options);
		await browser.api.session.signInWithPasskey({ credential });
		await expect(install.browser().api.session.signInWithPasskey({ credential })).rejects.toMatchObject({
			code: "PASSKEY_INVALID",
		});
	});

	test("refuses a signature count that goes backwards: the passkey may have been copied", async () => {
		const { device } = await personWithPasskey();
		await signInWithPasskey(device);
		await signInWithPasskey(device);

		await expect(signInWithPasskey(device, { signCount: 1 })).rejects.toMatchObject({ code: "PASSKEY_INVALID" });
	});

	test("a passkey nobody has here is refused", async () => {
		const stranger = softwareAuthenticator();
		await stranger.create({
			challenge: "Y2hhbGxlbmdl",
			rp: { id: TEST_RP_ID, name: "WebCraft" },
			user: { id: "c29tZW9uZQ", name: "someone@example.org", displayName: "Someone" },
			pubKeyCredParams: [{ type: "public-key", alg: -7 }],
		});
		await expect(signInWithPasskey(stranger)).rejects.toMatchObject({ code: "PASSKEY_INVALID", status: 401 });
	});

	test("passkey sign-in is rate-limited per client address", async () => {
		const browser = install.browser();
		const answers: string[] = [];
		for (let attempt = 0; attempt < 11; attempt++) {
			answers.push(
				await browser.api.session.passkeyOptions().then(
					() => "ok",
					(error: { code: string }) => error.code,
				),
			);
		}
		expect(answers.at(-1)).toBe("TOO_MANY_REQUESTS");
		await install.clock.advance(MINUTE);
	});
});

describe("confirming who you are with a passkey or an authenticator app", () => {
	test("a passkey makes a fresh identity check", async () => {
		const { device } = await personWithPasskey();
		const { browser } = await signInWithPasskey(device);
		await install.clock.advance(11 * MINUTE);
		await expect(browser.api.me.twoFactor.regenerateBackupCodes()).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
		});

		const { options } = await browser.api.session.identityPasskeyOptions();
		expect(options.allowCredentials).toEqual([
			{ id: device.credentialIds[0] ?? "", type: "public-key", transports: ["internal", "hybrid"] },
		]);
		await browser.api.session.confirmIdentity({ passkey: await device.get(options) });

		expect((await browser.api.me.twoFactor.regenerateBackupCodes()).backupCodes).toHaveLength(10);
	});

	test("another person's passkey, or a wrong signature, is refused", async () => {
		const { device } = await personWithPasskey();
		const other = await personWithPasskey();
		const { browser } = await signInWithPasskey(device);

		const { options } = await browser.api.session.identityPasskeyOptions();
		await expect(
			browser.api.session.confirmIdentity({ passkey: await other.device.get({ ...options, allowCredentials: [] }) }),
		).rejects.toMatchObject({ code: "PASSKEY_INVALID" });
		const { options: again } = await browser.api.session.identityPasskeyOptions();
		await expect(
			browser.api.session.confirmIdentity({ passkey: await device.get(again, { wrongKey: true }) }),
		).rejects.toMatchObject({ code: "PASSKEY_INVALID" });
	});

	test("a code from the authenticator app makes a fresh identity check; a wrong one counts towards the lockout", async () => {
		const { browser, account } = await newPerson();
		const { secret } = await addAuthenticator(install, browser);
		const signedIn = await signInWithAuthenticator(install, account, secret);
		await install.clock.advance(11 * MINUTE);

		await expect(signedIn.api.session.confirmIdentity({ authenticatorCode: "000000" })).rejects.toMatchObject({
			code: "TWO_FACTOR_CODE_INVALID",
			status: 401,
		});
		await signedIn.api.session.confirmIdentity({ authenticatorCode: totpCode(secret, install.clock.now()) });
		await confirmIfAsked(signedIn, account.password, () => signedIn.api.me.twoFactor.regenerateBackupCodes());
	});
});

describe("removing a passkey", () => {
	test("it no longer signs in; the person is emailed and their other sessions end", async () => {
		const { device, account } = await personWithPasskey();
		const { browser } = await signInWithPasskey(device);
		const { browser: phone } = await signInWithPasskey(device);
		const [passkey] = (await browser.api.me.twoFactor.get()).passkeys;

		await browser.api.me.twoFactor.removePasskey({ passkeyId: passkey?.id ?? "" });

		expect((await install.lastEmailTo(account.email)).subject).toBe("A passkey was removed from your account");
		expect((await phone.api.session.current()).person).toBeNull();
		expect(await browser.api.me.twoFactor.get()).toMatchObject({ passkeys: [], backupCodes: { left: 0 } });
		await expect(signInWithPasskey(device)).rejects.toMatchObject({ code: "PASSKEY_INVALID" });
	});

	test("only the person's own passkeys", async () => {
		const { browser } = await newPerson();
		const other = await personWithPasskey();
		const { browser: otherBrowser } = await signInWithPasskey(other.device);
		const [theirs] = (await otherBrowser.api.me.twoFactor.get()).passkeys;

		await expect(browser.api.me.twoFactor.removePasskey({ passkeyId: theirs?.id ?? "" })).rejects.toMatchObject({
			code: "TWO_FACTOR_NOT_FOUND",
		});
	});
});
