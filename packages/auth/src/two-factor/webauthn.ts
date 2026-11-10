/**
 * WebAuthn (passkeys), the relying party's half, with Web Crypto only: registration and assertion
 * checks as the WebAuthn Level 3 recommendation lays them out (§7.1, §7.2). WebCraft asks for no
 * attestation (`attestation: "none"`): it trusts the key the authenticator gives, never a statement
 * about the device, so attestation statements are ignored and no certificate chain is checked.
 *
 * The relying party is the admin's hostname, and only the admin's origin may use it.
 */
import { base64url, fromBase64url } from "./pending.ts";

/** The admin as a WebAuthn relying party. */
export type RelyingParty = { id: string; origin: string; name: string };

/** COSE algorithms WebCraft accepts, in the order it prefers them. */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;

const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED = 0x40;
const FLAG_EXTENSIONS = 0x80;

/** A passkey ceremony's answer was refused. `reason` is for the log; people see one plain message. */
export class PasskeyInvalidError extends Error {
	override name = "PasskeyInvalidError";
	readonly reason: string;
	readonly during: "setup" | "sign-in" | "identity";
	constructor(reason: string, during: "setup" | "sign-in" | "identity") {
		super("The passkey couldn't be used. Try again, or use another way.");
		this.reason = reason;
		this.during = during;
	}
}

/** A registration answer as the browser's `PublicKeyCredential.toJSON()` gives it (binary as base64url). */
export type RegistrationCredential = {
	id: string;
	rawId: string;
	type: string;
	response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
};

/** An assertion answer as the browser's `PublicKeyCredential.toJSON()` gives it. */
export type AssertionCredential = {
	id: string;
	rawId: string;
	type: string;
	response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
};

/** A verified new passkey, ready to store. */
export type NewPasskey = {
	credentialId: string;
	publicKey: Uint8Array;
	algorithm: number;
	signCount: number;
	transports: string[];
	backedUp: boolean;
};

/** Registration options for `navigator.credentials.create`, as JSON. */
export function creationOptions(
	rp: RelyingParty,
	user: { id: string; name: string; displayName: string },
	challenge: string,
	exclude: { credentialId: string; transports: string[] }[],
) {
	return {
		challenge,
		rp: { id: rp.id, name: rp.name },
		user: { id: base64url(new TextEncoder().encode(user.id)), name: user.name, displayName: user.displayName },
		pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: "public-key" as const, alg })),
		excludeCredentials: exclude.map((credential) => ({
			id: credential.credentialId,
			type: "public-key" as const,
			...(credential.transports.length > 0 ? { transports: credential.transports } : {}),
		})),
		// A passkey: kept on the device (discoverable), unlocked with the person's PIN, fingerprint or face.
		authenticatorSelection: { residentKey: "required" as const, userVerification: "required" as const },
		attestation: "none" as const,
		timeout: 300_000,
	};
}

/** Options for `navigator.credentials.get`, as JSON. With no credentials listed, the device offers its own. */
export function requestOptions(
	rp: RelyingParty,
	challenge: string,
	allow: { credentialId: string; transports: string[] }[],
) {
	return {
		challenge,
		rpId: rp.id,
		allowCredentials: allow.map((credential) => ({
			id: credential.credentialId,
			type: "public-key" as const,
			...(credential.transports.length > 0 ? { transports: credential.transports } : {}),
		})),
		userVerification: "required" as const,
		timeout: 300_000,
	};
}

/** The challenge a ceremony's client data says it answers, or null when the client data can't be read. */
export function challengeOf(clientDataJSON: string): string | null {
	try {
		const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(clientDataJSON)));
		return typeof data?.challenge === "string" ? data.challenge : null;
	} catch {
		return null;
	}
}

/** Checks a registration answer against the challenge it was given, and answers the passkey to store. */
export async function verifyRegistration(
	credential: RegistrationCredential,
	expected: { challenge: string; rp: RelyingParty },
): Promise<NewPasskey> {
	const refuse = (reason: string): never => {
		throw new PasskeyInvalidError(reason, "setup");
	};
	if (credential.type !== "public-key") refuse("not a public key credential");
	if (credential.id !== credential.rawId) refuse("id and rawId differ");
	checkClientData(credential.response.clientDataJSON, "webauthn.create", expected, refuse);

	const attestation = decodeCborOrRefuse(credential.response.attestationObject, refuse);
	if (!(attestation instanceof Map)) return refuse("attestation object is not a map");
	const authData = attestation.get("authData");
	if (!(authData instanceof Uint8Array)) return refuse("no authenticator data");
	const parsed = await parseAuthenticatorData(authData, expected.rp, refuse);
	if (!(parsed.flags & FLAG_ATTESTED) || !parsed.attested) return refuse("no credential in the authenticator data");
	if (base64url(parsed.attested.credentialId) !== credential.rawId) refuse("credential id differs from rawId");
	if (parsed.attested.credentialId.length > 1023) refuse("credential id too long");
	// Refuses keys of an algorithm it doesn't take, or that don't import.
	const algorithm = await importCoseKey(parsed.attested.publicKey, refuse).then((key) => key.algorithm);
	return {
		credentialId: credential.rawId,
		publicKey: parsed.attested.publicKey,
		algorithm,
		signCount: parsed.signCount,
		transports: (credential.response.transports ?? [])
			.filter((transport) => /^[a-z-]{1,20}$/.test(transport))
			.slice(0, 10),
		backedUp: (parsed.flags & FLAG_BACKED_UP) !== 0,
	};
}

/**
 * Checks an assertion against the challenge it was given and the stored passkey it names, and
 * answers the new signature count and backup state. A count that doesn't go up (once either is
 * above 0) is refused: the passkey may have been copied.
 */
export async function verifyAssertion(
	credential: AssertionCredential,
	expected: { challenge: string; rp: RelyingParty; during: "sign-in" | "identity" },
	stored: { publicKey: Uint8Array; signCount: number },
): Promise<{ signCount: number; backedUp: boolean }> {
	const refuse = (reason: string): never => {
		throw new PasskeyInvalidError(reason, expected.during);
	};
	if (credential.type !== "public-key") refuse("not a public key credential");
	if (credential.id !== credential.rawId) refuse("id and rawId differ");
	const clientData = bytesOrRefuse(credential.response.clientDataJSON, refuse);
	checkClientData(credential.response.clientDataJSON, "webauthn.get", expected, refuse);
	const authData = bytesOrRefuse(credential.response.authenticatorData, refuse);
	const parsed = await parseAuthenticatorData(authData, expected.rp, refuse);
	const signature = bytesOrRefuse(credential.response.signature, refuse);

	const key = await importCoseKey(stored.publicKey, refuse);
	const signed = concat(authData, new Uint8Array(await crypto.subtle.digest("SHA-256", clientData)));
	if (!(await verifySignature(key, signature, signed))) refuse("signature doesn't verify");

	if ((parsed.signCount > 0 || stored.signCount > 0) && parsed.signCount <= stored.signCount) {
		refuse("signature count didn't go up");
	}
	return { signCount: parsed.signCount, backedUp: (parsed.flags & FLAG_BACKED_UP) !== 0 };
}

function checkClientData(
	encoded: string,
	type: "webauthn.create" | "webauthn.get",
	expected: { challenge: string; rp: RelyingParty },
	refuse: (reason: string) => never,
): void {
	let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown; topOrigin?: unknown };
	try {
		data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(encoded)));
	} catch {
		refuse("client data is not JSON");
	}
	if (data.type !== type) refuse(`client data type is not ${type}`);
	if (data.challenge !== expected.challenge) refuse("challenge differs");
	if (data.origin !== expected.rp.origin) refuse("origin is not the admin's");
	// The admin is never framed, so a ceremony from inside another site's frame is not the admin's.
	if (data.crossOrigin === true || data.topOrigin !== undefined) refuse("made inside another site's frame");
}

type AuthenticatorData = {
	flags: number;
	signCount: number;
	attested: { credentialId: Uint8Array; publicKey: Uint8Array } | null;
};

/** Reads authenticator data (§6.1) and checks the relying party and that the person was present and verified. */
async function parseAuthenticatorData(
	bytes: Uint8Array,
	rp: RelyingParty,
	refuse: (reason: string) => never,
): Promise<AuthenticatorData> {
	if (bytes.length < 37) refuse("authenticator data too short");
	const expectedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rp.id)));
	if (!equalBytes(bytes.slice(0, 32), expectedHash)) refuse("relying party id differs");
	const flags = bytes[32] ?? 0;
	if (!(flags & FLAG_USER_PRESENT)) refuse("user not present");
	if (!(flags & FLAG_USER_VERIFIED)) refuse("user not verified");
	if (flags & FLAG_BACKED_UP && !(flags & FLAG_BACKUP_ELIGIBLE)) refuse("backed up but not backup eligible");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const signCount = view.getUint32(33);
	let offset = 37;
	let attested: AuthenticatorData["attested"] = null;
	if (flags & FLAG_ATTESTED) {
		if (bytes.length < offset + 18) refuse("attested credential data too short");
		offset += 16; // AAGUID
		const idLength = view.getUint16(offset);
		offset += 2;
		const credentialId = bytes.slice(offset, offset + idLength);
		if (credentialId.length !== idLength) refuse("credential id cut short");
		offset += idLength;
		const { length } = decodeCbor(bytes, offset);
		attested = { credentialId, publicKey: bytes.slice(offset, offset + length) };
		offset += length;
	}
	if (flags & FLAG_EXTENSIONS) {
		if (offset >= bytes.length) refuse("extensions flagged but missing");
		offset += decodeCbor(bytes, offset).length;
	}
	if (offset !== bytes.length) refuse("unexpected bytes after authenticator data");
	return { flags, signCount, attested };
}

/** A COSE public key (RFC 9053) as a Web Crypto key WebCraft can verify signatures with. */
async function importCoseKey(
	cose: Uint8Array,
	refuse: (reason: string) => never,
): Promise<{ algorithm: number; key: CryptoKey }> {
	let map: unknown;
	try {
		map = decodeCbor(cose, 0).value;
	} catch {
		return refuse("public key is not CBOR");
	}
	if (!(map instanceof Map)) return refuse("public key is not a COSE key");
	const kty = map.get(1);
	const alg = map.get(3);
	const b64 = (value: unknown) => (value instanceof Uint8Array ? base64url(value) : refuse("key part is not bytes"));
	try {
		if (alg === ES256 && kty === 2 && map.get(-1) === 1) {
			const x = b64(map.get(-2));
			const y = b64(map.get(-3));
			const key = await crypto.subtle.importKey(
				"jwk",
				{ kty: "EC", crv: "P-256", x, y },
				{ name: "ECDSA", namedCurve: "P-256" },
				false,
				["verify"],
			);
			return { algorithm: ES256, key };
		}
		if (alg === EDDSA && kty === 1 && map.get(-1) === 6) {
			const key = await crypto.subtle.importKey(
				"jwk",
				{ kty: "OKP", crv: "Ed25519", x: b64(map.get(-2)) },
				{ name: "Ed25519" },
				false,
				["verify"],
			);
			return { algorithm: EDDSA, key };
		}
		if (alg === RS256 && kty === 3) {
			const key = await crypto.subtle.importKey(
				"jwk",
				{ kty: "RSA", n: b64(map.get(-1)), e: b64(map.get(-2)), alg: "RS256" },
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"],
			);
			return { algorithm: RS256, key };
		}
	} catch (error) {
		if (error instanceof PasskeyInvalidError) throw error;
		return refuse("public key doesn't import");
	}
	return refuse(`algorithm ${String(alg)} is not one WebCraft takes`);
}

async function verifySignature(
	{ algorithm, key }: { algorithm: number; key: CryptoKey },
	signature: Uint8Array<ArrayBuffer>,
	data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
	try {
		if (algorithm === ES256) {
			const raw = rawEcdsaSignature(signature);
			return raw !== null && (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, data));
		}
		if (algorithm === EDDSA) return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data);
		return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, data);
	} catch {
		return false;
	}
}

/** An ECDSA P-256 signature from ASN.1 DER (`SEQUENCE { INTEGER r, INTEGER s }`) to the `r || s` Web Crypto takes. */
function rawEcdsaSignature(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
	if (der[0] !== 0x30 || der[1] !== der.length - 2 || der.length > 72) return null;
	let offset = 2;
	const out = new Uint8Array(64);
	for (const half of [0, 1]) {
		if (der[offset] !== 0x02) return null;
		const length = der[offset + 1] ?? 0;
		let integer = der.slice(offset + 2, offset + 2 + length);
		if (integer.length !== length || length === 0) return null;
		offset += 2 + length;
		while (integer.length > 32 && integer[0] === 0) integer = integer.slice(1);
		if (integer.length > 32) return null;
		out.set(integer, half * 32 + (32 - integer.length));
	}
	return offset === der.length ? out : null;
}

function bytesOrRefuse(text: string, refuse: (reason: string) => never): Uint8Array<ArrayBuffer> {
	try {
		return fromBase64url(text);
	} catch {
		return refuse("not base64url");
	}
}

function decodeCborOrRefuse(text: string, refuse: (reason: string) => never): unknown {
	const bytes = bytesOrRefuse(text, refuse);
	try {
		const { value, length } = decodeCbor(bytes, 0);
		if (length !== bytes.length) refuse("bytes after the CBOR value");
		return value;
	} catch (error) {
		if (error instanceof PasskeyInvalidError) throw error;
		return refuse("not CBOR");
	}
}

/**
 * Reads one CBOR value (RFC 8949) at `offset`: unsigned and negative integers, byte and text
 * strings, arrays, maps (as `Map`, keeping integer keys) and the simple values WebAuthn uses.
 * Indefinite lengths, tags and floats aren't used by WebAuthn's structures and are refused.
 */
export function decodeCbor(bytes: Uint8Array, at: number, depth = 0): { value: unknown; length: number } {
	if (depth > 16) throw new TypeError("CBOR nested too deeply.");
	const start = at;
	let offset = at;
	const initial = bytes[offset++];
	if (initial === undefined) throw new TypeError("CBOR cut short.");
	const major = initial >> 5;
	const info = initial & 31;
	const readLength = (): number => {
		if (info < 24) return info;
		const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
		if (size === 0 || offset + size > bytes.length) throw new TypeError("CBOR length not supported.");
		let value = 0;
		for (let index = 0; index < size; index++) value = value * 256 + (bytes[offset + index] ?? 0);
		offset += size;
		if (!Number.isSafeInteger(value)) throw new TypeError("CBOR number too large.");
		return value;
	};
	switch (major) {
		case 0:
			return { value: readLength(), length: offset - start };
		case 1:
			return { value: -1 - readLength(), length: offset - start };
		case 2:
		case 3: {
			const length = readLength();
			if (offset + length > bytes.length) throw new TypeError("CBOR string cut short.");
			const slice = bytes.slice(offset, offset + length);
			offset += length;
			const value = major === 2 ? slice : new TextDecoder("utf-8", { fatal: true }).decode(slice);
			return { value, length: offset - start };
		}
		case 4: {
			const count = readLength();
			const items: unknown[] = [];
			for (let index = 0; index < count; index++) {
				const item = decodeCbor(bytes, offset, depth + 1);
				items.push(item.value);
				offset += item.length;
			}
			return { value: items, length: offset - start };
		}
		case 5: {
			const count = readLength();
			const map = new Map<unknown, unknown>();
			for (let index = 0; index < count; index++) {
				const key = decodeCbor(bytes, offset, depth + 1);
				offset += key.length;
				const entry = decodeCbor(bytes, offset, depth + 1);
				offset += entry.length;
				if (map.has(key.value)) throw new TypeError("CBOR map key repeated.");
				map.set(key.value, entry.value);
			}
			return { value: map, length: offset - start };
		}
		case 7:
			if (info === 20) return { value: false, length: 1 };
			if (info === 21) return { value: true, length: 1 };
			if (info === 22) return { value: null, length: 1 };
			throw new TypeError("CBOR simple value not supported.");
		default:
			throw new TypeError("CBOR type not supported.");
	}
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
