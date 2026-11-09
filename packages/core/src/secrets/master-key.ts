import { ConfigError, type Environment } from "../config.ts";

/** The environment variable that holds the Install's Master key. */
export const MASTER_KEY_VARIABLE = "WEBCRAFT_SECRET_KEY";

/** The shortest Master key WebCraft accepts, in characters. */
export const MASTER_KEY_MIN_LENGTH = 32;

const MAKE_ONE = "Make one with `openssl rand -base64 32` and keep a copy outside the server.";

/**
 * Every key below is derived from the Master key with HKDF-SHA256, using this salt and a label
 * (the HKDF "info") per purpose, so a fingerprint reveals nothing about the encryption keys.
 */
const HKDF_SALT = new TextEncoder().encode("webcraft master key");
const FINGERPRINT_LABEL = "webcraft master key fingerprint";
const SESSION_SIGNING_LABEL = "webcraft session cookie signing";
const EDIT_MODE_LABEL = "webcraft edit mode header token";
const DOMAIN_VERIFICATION_LABEL = "webcraft domain verification";
const FORM_TIME_LABEL = "webcraft form time trap";
const secretsKeyLabel = (version: number) => `webcraft secrets aes-256-gcm key version ${version}`;

type Derived = {
	/** The Master key imported for HKDF; it can't be exported again. */
	base: Promise<CryptoKey>;
	fingerprint?: Promise<string>;
	secretsKeys: Map<number, Promise<CryptoKey>>;
};

/** What each Master key derives. Only this module can reach it. */
const derived = new WeakMap<MasterKey, Derived>();

/**
 * The secret an Install is started with, which encrypts every stored secret. The key itself can't
 * be read back from this object: it only derives the keys the secrets module encrypts with, and a
 * fingerprint that is safe to store.
 */
export class MasterKey {
	/**
	 * A one-way value that identifies this key without revealing it: 64 hexadecimal characters,
	 * safe to store and show. Backup manifests carry it, and restore compares it with the running
	 * Install's key (ADR 0032). The same key always gives the same fingerprint.
	 */
	fingerprint(): Promise<string> {
		const state = stateOf(this);
		state.fingerprint ??= state.base.then(async (base) => {
			const bits = await crypto.subtle.deriveBits(hkdf(FINGERPRINT_LABEL), base, 256);
			return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
		});
		return state.fingerprint;
	}

	toJSON(): string {
		return "[Master key]";
	}

	toString(): string {
		return "[Master key]";
	}
}

/**
 * Checks a Master key: at least 32 characters once surrounding whitespace is trimmed. `source`
 * names where it came from, such as `WEBCRAFT_SECRET_KEY`, in the error a bad key gives.
 */
export function parseMasterKey(value: string | undefined, source: string): MasterKey {
	const key = value?.trim() ?? "";
	if (key === "") {
		throw new ConfigError(
			`${source} is not set. It holds the Master key, which encrypts every stored secret. ${MAKE_ONE}`,
		);
	}
	if (Array.from(key).length < MASTER_KEY_MIN_LENGTH) {
		throw new ConfigError(
			`${source} is shorter than ${MASTER_KEY_MIN_LENGTH} characters. The Master key encrypts every stored secret, so it must be long and random. ${MAKE_ONE}`,
		);
	}
	return createMasterKey(key);
}

/** Reads the Master key from `WEBCRAFT_SECRET_KEY`, refusing to go on when it is missing or short. */
export function loadMasterKey(env: Environment): MasterKey {
	return parseMasterKey(env[MASTER_KEY_VARIABLE], MASTER_KEY_VARIABLE);
}

/**
 * The AES-256-GCM key that secrets of one key version are encrypted with, derived from the Master
 * key. It can encrypt and decrypt but never be exported. Only the secrets module uses it, so it is
 * not part of `@webcraft/core`'s public exports.
 */
export function secretsKey(masterKey: MasterKey, version: number): Promise<CryptoKey> {
	const state = stateOf(masterKey);
	let key = state.secretsKeys.get(version);
	if (!key) {
		key = state.base.then((base) =>
			crypto.subtle.deriveKey(hkdf(secretsKeyLabel(version)), base, { name: "AES-GCM", length: 256 }, false, [
				"encrypt",
				"decrypt",
			]),
		);
		state.secretsKeys.set(version, key);
	}
	return key;
}

/**
 * The secret that signs admin session cookies, derived from the Master key: every web process of an
 * Install has the same one without storing it, and a new Master key signs everyone out. Only the
 * Install's start-up uses it, so it is not part of `@webcraft/core`'s public exports.
 */
export async function sessionSigningSecret(masterKey: MasterKey): Promise<string> {
	const bits = await crypto.subtle.deriveBits(hkdf(SESSION_SIGNING_LABEL), await stateOf(masterKey).base, 256);
	return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The key Edit mode signs each Edit mode session's header token with (HMAC-SHA256), derived from
 * the Master key, so every web process makes and checks the same tokens without storing them. Only
 * the Install's start-up uses it, so it is not part of `@webcraft/core`'s public exports.
 */
export async function editModeSigningKey(masterKey: MasterKey): Promise<CryptoKey> {
	return crypto.subtle.deriveKey(
		hkdf(EDIT_MODE_LABEL),
		await stateOf(masterKey).base,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign", "verify"],
	);
}

/**
 * The key domain verification signs with (HMAC-SHA256), derived from the Master key: each domain's
 * token, and the answer `/_webcraft/verify/<token>` gives for it, which only this Install can make.
 * Web and worker derive the same one, so neither stores tokens. Only the Install's start-up uses it.
 */
export async function domainVerificationKey(masterKey: MasterKey): Promise<CryptoKey> {
	return crypto.subtle.deriveKey(
		hkdf(DOMAIN_VERIFICATION_LABEL),
		await stateOf(masterKey).base,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign", "verify"],
	);
}

/**
 * The key Forms sign their time-trap tokens with (HMAC-SHA256), derived from the Master key: the
 * time a page holding a Form was handed out, which a post sends back. Web processes make and check
 * them without storing them. Only the Install's start-up uses it.
 */
export async function formTimeKey(masterKey: MasterKey): Promise<CryptoKey> {
	return crypto.subtle.deriveKey(
		hkdf(FORM_TIME_LABEL),
		await stateOf(masterKey).base,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign", "verify"],
	);
}

/** Only keys made here derive anything; a `new MasterKey()` made elsewhere refuses to be used. */
function createMasterKey(value: string): MasterKey {
	const key = new MasterKey();
	derived.set(key, {
		base: crypto.subtle.importKey("raw", new TextEncoder().encode(value), "HKDF", false, ["deriveKey", "deriveBits"]),
		secretsKeys: new Map(),
	});
	return key;
}

function hkdf(label: string) {
	return { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: new TextEncoder().encode(label) };
}

function stateOf(masterKey: MasterKey): Derived {
	const state = derived.get(masterKey);
	if (!state) throw new TypeError("Not a Master key: use parseMasterKey or loadMasterKey.");
	return state;
}
