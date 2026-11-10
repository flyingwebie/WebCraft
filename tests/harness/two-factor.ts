import { createHmac } from "node:crypto";

import type { TestBrowser } from "./browser.ts";
import { TEST_PASSWORD, type TestAccount, type TestInstall } from "./index.ts";

/** One TOTP time step (RFC 6238), as authenticator apps use: 30 seconds. */
export const TOTP_STEP_MS = 30_000;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decodes a base32 secret as an authenticator app reads it from its QR code (any case, no padding). */
function base32Decode(text: string): Buffer {
	const clean = text.replace(/[\s=]/g, "").toUpperCase();
	let bits = "";
	for (const character of clean) {
		const value = BASE32.indexOf(character);
		if (value === -1) throw new Error(`"${character}" is not base32.`);
		bits += value.toString(2).padStart(5, "0");
	}
	const bytes: number[] = [];
	for (let start = 0; start + 8 <= bits.length; start += 8)
		bytes.push(Number.parseInt(bits.slice(start, start + 8), 2));
	return Buffer.from(bytes);
}

/**
 * The 6-digit code an authenticator app shows at `at` for a base32 secret: HOTP (RFC 4226) over the
 * 30-second step, with HMAC-SHA1, as every common app computes it.
 */
export function totpCode(secret: string, at: Date, stepOffset = 0): string {
	const step = Math.floor(at.getTime() / TOTP_STEP_MS) + stepOffset;
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
	const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
	const binary = digest.readUInt32BE(offset) & 0x7fffffff;
	return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Adds an authenticator app to a signed-in browser's account the way a person does: starts it,
 * reads the secret the admin shows, and confirms with the app's current code. Answers the secret
 * and the backup codes shown once.
 */
export async function addAuthenticator(
	install: TestInstall,
	browser: TestBrowser,
	password = TEST_PASSWORD,
): Promise<{ secret: string; backupCodes: string[] }> {
	const { secret } = await confirmIfAsked(browser, password, () => browser.api.me.twoFactor.startAuthenticator());
	const { backupCodes } = await browser.api.me.twoFactor.confirmAuthenticator({
		code: totpCode(secret, install.clock.now()),
	});
	return { secret, backupCodes: backupCodes ?? [] };
}

/**
 * Signs in a person who has an authenticator app: their password, then the app's code. The clock
 * moves on one step first, so the code is one no sign-in has used yet.
 */
export async function signInWithAuthenticator(
	install: TestInstall,
	account: Pick<TestAccount, "email" | "password">,
	secret: string,
): Promise<TestBrowser> {
	await install.clock.advance(TOTP_STEP_MS);
	const browser = install.browser();
	const first = await browser.api.session.signIn({ email: account.email, password: account.password });
	if (!first.secondStep) throw new Error(`${account.email} signed in without a second step.`);
	await browser.api.session.secondStep({ method: "authenticator", code: totpCode(secret, install.clock.now()) });
	return browser;
}

/** Runs a Sensitive action, confirming the password first when the session's identity check is old. */
export async function confirmIfAsked<Result>(
	browser: TestBrowser,
	password: string,
	call: () => Promise<Result>,
): Promise<Result> {
	try {
		return await call();
	} catch (error) {
		if ((error as { code?: string }).code !== "IDENTITY_CHECK_REQUIRED") throw error;
		await browser.api.session.confirmIdentity({ password });
		return call();
	}
}
