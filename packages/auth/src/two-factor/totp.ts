/**
 * Time-based one-time codes (TOTP, RFC 6238) as every common authenticator app makes them: HMAC-SHA1
 * over 30-second steps, 6 digits. Only Web Crypto, so it runs on Bun and Node alike.
 */

/** Seconds in one time step. */
export const TOTP_PERIOD_SECONDS = 30;

/** Digits in a code. */
export const TOTP_DIGITS = 6;

/** How many steps before or after now a code may come from: a phone's clock a little off still works. */
export const TOTP_WINDOW = 1;

/** Bytes in a new secret: 160 bits, the size RFC 4226 recommends. */
const SECRET_BYTES = 20;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A new random secret, base32 without padding (32 characters), as apps read it from a QR code. */
export function newTotpSecret(): string {
	return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** The time step `at` falls in. */
export function totpStep(at: Date): number {
	return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * The address an authenticator app reads from the QR code (`otpauth://totp/…`): the issuer (the
 * Install's name) and the person's email as the account's label, the secret and the code's shape.
 */
export function otpauthUri(secret: string, issuer: string, accountName: string): string {
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
	const parameters = new URLSearchParams({
		secret,
		issuer,
		algorithm: "SHA1",
		digits: String(TOTP_DIGITS),
		period: String(TOTP_PERIOD_SECONDS),
	});
	return `otpauth://totp/${label}?${parameters.toString().replaceAll("+", "%20")}`;
}

/** Whether `code` looks like a code an app shows: 6 digits (spaces, as some apps group them, ignored). */
export function normaliseTotpCode(code: string): string | null {
	const digits = code.replace(/\s/g, "");
	return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * The step a code belongs to, among the steps around `now` (`TOTP_WINDOW` either side) that come
 * after `afterStep`, or null when it matches none. Every candidate is computed and compared in
 * constant time, so how long it takes tells nothing about the code.
 */
export async function matchingTotpStep(
	secret: string,
	code: string,
	now: Date,
	afterStep: number | null,
): Promise<number | null> {
	const digits = normaliseTotpCode(code);
	const key = await hmacKey(secret);
	const current = totpStep(now);
	let found: number | null = null;
	for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
		const step = current + offset;
		const expected = await codeAt(key, step);
		const same = equalInConstantTime(expected, digits ?? "------");
		if (same && digits !== null && (afterStep === null || step > afterStep) && found === null) found = step;
	}
	return found;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
}

/** HOTP (RFC 4226) for one counter. */
async function codeAt(key: CryptoKey, step: number): Promise<string> {
	const counter = new Uint8Array(8);
	new DataView(counter.buffer).setBigUint64(0, BigInt(step));
	const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
	const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
	const binary = new DataView(digest.buffer).getUint32(offset) & 0x7fffffff;
	return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Compares two strings of the same length without stopping at the first difference. */
export function equalInConstantTime(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let output = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
	return output;
}

function base32Decode(text: string): Uint8Array<ArrayBuffer> {
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const character of text.toUpperCase()) {
		const index = BASE32.indexOf(character);
		if (index === -1) throw new TypeError("A TOTP secret is base32.");
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return new Uint8Array(bytes);
}
