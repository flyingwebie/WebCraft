import { z } from "zod";
import { SECRET_MAX_LENGTH } from "../secrets/store.ts";

/**
 * A Site export carries the Site's secrets (its SMTP password, CDN token, Webhook and CAPTCHA
 * secrets, its Modules' secrets) only under an export passphrase the exporter chooses (ADR 0032):
 * never under the Master key and never in plain text. The passphrase is never stored; a key is
 * derived from it with PBKDF2-SHA256 (a random salt, many rounds), and each secret is encrypted with
 * AES-256-GCM under that key, bound to its name. A known value encrypted the same way lets an import
 * tell a wrong passphrase at once.
 *
 * Between the person typing the passphrase and the worker using it, only the derived key is kept, as
 * an Install secret (so under the Master key, like every secret) removed when the job ends.
 */

/** PBKDF2-SHA256 rounds: OWASP's recommendation for it (2023). */
export const PASSPHRASE_ROUNDS = 600_000;
/** The fewest and most rounds an archive may ask for: fewer is too weak, more would keep the web process busy. */
const ROUNDS_RANGE = { min: 100_000, max: 5_000_000 };

export { PASSPHRASE_MAX_LENGTH, PASSPHRASE_MIN_LENGTH } from "./rules.ts";

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const kdfSchema = z.object({
	name: z.literal("PBKDF2-SHA256"),
	rounds: z.number().int().min(ROUNDS_RANGE.min).max(ROUNDS_RANGE.max),
	salt: base64,
});
export type Kdf = z.infer<typeof kdfSchema>;

const sealedSchema = z.object({ iv: base64, ciphertext: base64 });
type Sealed = z.infer<typeof sealedSchema>;

/** `secrets.json`: how the key was derived, the passphrase check, and each secret by name. */
export const secretsBundleSchema = z.object({
	kdf: kdfSchema,
	check: sealedSchema,
	secrets: z.array(sealedSchema.extend({ name: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/) })),
});
export type SecretsBundle = z.infer<typeof secretsBundleSchema>;

const CHECK_TEXT = "webcraft site export";
const encoder = new TextEncoder();

/** A new derivation: PBKDF2-SHA256 with a random 16-byte salt. */
export function newKdf(): Kdf {
	return {
		name: "PBKDF2-SHA256",
		rounds: PASSPHRASE_ROUNDS,
		salt: toBase64(crypto.getRandomValues(new Uint8Array(16))),
	};
}

/** The key a passphrase gives under a derivation, as base64 (how it is kept, as a secret, until the job ends). */
export async function passphraseKey(passphrase: string, kdf: Kdf): Promise<string> {
	const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase.normalize("NFC")), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(kdf.salt), iterations: kdf.rounds },
		base,
		256,
	);
	return toBase64(new Uint8Array(bits));
}

/**
 * Encrypts secrets under a key `passphraseKey` gave, one at a time (so each value can be sealed inside
 * the `useWith` callback that holds it), and the passphrase check.
 */
export async function secretSealer(key: string): Promise<{
	secret(name: string, value: string): Promise<SecretsBundle["secrets"][number]>;
	check(): Promise<Sealed>;
}> {
	const aes = await aesKey(key);
	return {
		secret: async (name, value) => ({ name, ...(await seal(aes, `secret:${name}`, value)) }),
		check: () => seal(aes, "check", CHECK_TEXT),
	};
}

/** Whether the key opens the bundle's check: the passphrase was the right one. */
export async function keyOpens(key: string, check: Sealed): Promise<boolean> {
	return (await open(await aesKey(key), "check", check)) === CHECK_TEXT;
}

/** The secrets of a bundle, decrypted; one that doesn't decrypt (changed since) is left out and named. */
export async function openSecrets(
	key: string,
	bundle: SecretsBundle,
): Promise<{ opened: { name: string; value: string }[]; unreadable: string[] }> {
	const aes = await aesKey(key);
	const opened: { name: string; value: string }[] = [];
	const unreadable: string[] = [];
	for (const secret of bundle.secrets) {
		const value = await open(aes, `secret:${secret.name}`, secret);
		if (value === null || value === "" || value.length > SECRET_MAX_LENGTH) unreadable.push(secret.name);
		else opened.push({ name: secret.name, value });
	}
	return { opened, unreadable };
}

async function aesKey(key: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", fromBase64(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(key: CryptoKey, what: string, value: string): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: encoder.encode(`webcraft site export ${what}`) },
		key,
		encoder.encode(value),
	);
	return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

async function open(key: CryptoKey, what: string, sealed: Sealed): Promise<string | null> {
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: encoder.encode(`webcraft site export ${what}`) },
			key,
			fromBase64(sealed.ciphertext),
		);
		return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
	} catch {
		return null;
	}
}

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Buffer.from(text, "base64"));
}
