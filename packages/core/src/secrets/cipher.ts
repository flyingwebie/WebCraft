import { type MasterKey, secretsKey } from "./master-key.ts";
import { ownerColumns, type SecretRef } from "./refs.ts";

/** A secret's value as it is stored: encrypted, under one key version. */
export type Sealed = {
	/** The 12-byte nonce, new for every encryption. */
	iv: Uint8Array;
	/** The encrypted value followed by the 16-byte authentication tag. */
	ciphertext: Uint8Array;
};

/** AES-GCM's recommended nonce length. A random nonce per encryption is safe for this few values. */
const IV_BYTES = 12;

/** Encrypts `value` with AES-256-GCM under key version `version` of `masterKey`, bound to `secret`. */
export async function seal(masterKey: MasterKey, version: number, secret: SecretRef, value: string): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: authenticatedData(secret) },
		await secretsKey(masterKey, version),
		new TextEncoder().encode(value),
	);
	return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * Decrypts a sealed value, or returns null when it can't be: it was changed, sealed for another
 * secret, or sealed under another key.
 */
export async function unseal(
	masterKey: MasterKey,
	version: number,
	secret: SecretRef,
	sealed: Sealed,
): Promise<string | null> {
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: new Uint8Array(sealed.iv), additionalData: authenticatedData(secret) },
			await secretsKey(masterKey, version),
			new Uint8Array(sealed.ciphertext),
		);
		return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
	} catch {
		return null;
	}
}

/**
 * The authenticated data of a secret's ciphertext: its owner and name. Decrypting with any other
 * owner or name fails, so a ciphertext copied into another row is useless there.
 */
function authenticatedData({ owner, name }: SecretRef): Uint8Array<ArrayBuffer> {
	const { workspaceId, siteId } = ownerColumns(owner);
	return new TextEncoder().encode(JSON.stringify(["webcraft secret", owner.kind, workspaceId, siteId, name]));
}
