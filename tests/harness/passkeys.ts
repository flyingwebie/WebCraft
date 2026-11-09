// A software authenticator: it makes passkeys and signs in with them the way a phone, a laptop's
// fingerprint reader or a security key does through the browser, answering WebAuthn ceremonies
// with the JSON a browser's `PublicKeyCredential.toJSON()` gives. Keys are made in the test with
// Web Crypto; nothing is copied from anywhere.
import { createHash, randomBytes } from "node:crypto";

import { TEST_ADMIN_HOST, TEST_ADMIN_ORIGIN } from "./index.ts";

export type PasskeyAlgorithm = "ES256" | "EdDSA" | "RS256";

/** The registration options the admin hands to `navigator.credentials.create`, as JSON. */
export type CreationOptions = {
	challenge: string;
	rp: { id: string; name: string };
	user: { id: string; name: string; displayName: string };
	pubKeyCredParams: { type: string; alg: number }[];
	excludeCredentials?: { id: string; type: string }[];
	authenticatorSelection?: { residentKey?: string; userVerification?: string };
	attestation?: string;
	timeout?: number;
};

/** The options the admin hands to `navigator.credentials.get`, as JSON. */
export type RequestOptions = {
	challenge: string;
	rpId: string;
	allowCredentials?: { id: string; type: string }[];
	userVerification?: string;
	timeout?: number;
};

type StoredCredential = {
	id: Uint8Array;
	algorithm: PasskeyAlgorithm;
	keys: CryptoKeyPair;
	rpId: string;
	userHandle: string;
	signCount: number;
};

/** What a ceremony may do differently from an honest authenticator in an honest browser, to test refusals. */
export type Tamper = {
	/** The page's origin the browser reports (a Site's domain, a look-alike). */
	origin?: string;
	/** The relying party the authenticator signs for. */
	rpId?: string;
	/** Leave out user verification (no PIN or fingerprint). */
	noUserVerification?: boolean;
	/** Report this signature count instead of the next one. */
	signCount?: number;
	/** Answer another challenge than the one asked. */
	challenge?: string;
	/** Sign with another key than the credential's. */
	wrongKey?: boolean;
	/** The ceremony type in the client data. */
	type?: string;
};

export type SoftwareAuthenticator = {
	/** Makes a new passkey, as `navigator.credentials.create({ publicKey })` would. */
	create(options: CreationOptions, tamper?: Tamper): Promise<RegistrationResponse>;
	/**
	 * Signs in with one of its passkeys, as `navigator.credentials.get({ publicKey })` would: one the
	 * options allow, or (with none listed) its newest for the relying party. `credentialId` picks one.
	 */
	get(options: RequestOptions, tamper?: Tamper & { credentialId?: string }): Promise<AuthenticationResponse>;
	/** The ids of the passkeys it holds, base64url, oldest first. */
	readonly credentialIds: string[];
};

export type RegistrationResponse = {
	id: string;
	rawId: string;
	type: "public-key";
	authenticatorAttachment: "platform";
	response: { clientDataJSON: string; attestationObject: string; transports: string[] };
	clientExtensionResults: Record<string, never>;
};

export type AuthenticationResponse = {
	id: string;
	rawId: string;
	type: "public-key";
	authenticatorAttachment: "platform";
	response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string };
	clientExtensionResults: Record<string, never>;
};

const COSE_ALGORITHM = { ES256: -7, EdDSA: -8, RS256: -257 } as const;

export function softwareAuthenticator({
	origin = TEST_ADMIN_ORIGIN,
	algorithm = "ES256",
	synced = true,
}: {
	origin?: string;
	algorithm?: PasskeyAlgorithm;
	synced?: boolean;
} = {}): SoftwareAuthenticator {
	const credentials: StoredCredential[] = [];

	return {
		get credentialIds() {
			return credentials.map((credential) => base64url(credential.id));
		},

		async create(options, tamper = {}) {
			const wanted = options.pubKeyCredParams.map((param) => param.alg);
			if (!wanted.includes(COSE_ALGORITHM[algorithm])) throw new Error(`The relying party doesn't take ${algorithm}.`);
			const rpId = tamper.rpId ?? options.rp.id;
			const excluded = new Set((options.excludeCredentials ?? []).map((credential) => credential.id));
			if (credentials.some((credential) => credential.rpId === rpId && excluded.has(base64url(credential.id)))) {
				throw new Error("InvalidStateError: this authenticator already holds a passkey for the account.");
			}
			const credential: StoredCredential = {
				id: new Uint8Array(randomBytes(32)),
				algorithm,
				keys: await generateKeys(algorithm),
				rpId,
				userHandle: options.user.id,
				signCount: 0,
			};
			credentials.push(credential);
			const clientDataJSON = clientData(
				tamper.type ?? "webauthn.create",
				tamper.challenge ?? options.challenge,
				tamper.origin ?? origin,
			);
			const authData = concat(
				sha256(rpId),
				new Uint8Array([flags({ uv: !tamper.noUserVerification, at: true, synced })]),
				uint32(tamper.signCount ?? credential.signCount),
				new Uint8Array(16), // AAGUID: none given, as with attestation "none".
				uint16(credential.id.length),
				credential.id,
				await coseKey(credential),
			);
			const attestationObject = encodeCbor(
				new Map<unknown, unknown>([
					["fmt", "none"],
					["attStmt", new Map()],
					["authData", authData],
				]),
			);
			return {
				id: base64url(credential.id),
				rawId: base64url(credential.id),
				type: "public-key",
				authenticatorAttachment: "platform",
				response: {
					clientDataJSON: base64url(clientDataJSON),
					attestationObject: base64url(attestationObject),
					transports: ["internal", "hybrid"],
				},
				clientExtensionResults: {},
			};
		},

		async get(options, tamper = {}) {
			const rpId = tamper.rpId ?? options.rpId;
			const allowed = new Set((options.allowCredentials ?? []).map((credential) => credential.id));
			const candidates = credentials.filter(
				(credential) =>
					(tamper.rpId !== undefined || credential.rpId === rpId) &&
					(allowed.size === 0 || allowed.has(base64url(credential.id))) &&
					(tamper.credentialId === undefined || base64url(credential.id) === tamper.credentialId),
			);
			const credential = candidates.at(-1);
			if (!credential) throw new Error("NotAllowedError: no passkey for this relying party.");
			credential.signCount += 1;
			const clientDataJSON = clientData(
				tamper.type ?? "webauthn.get",
				tamper.challenge ?? options.challenge,
				tamper.origin ?? origin,
			);
			const authenticatorData = concat(
				sha256(rpId),
				new Uint8Array([flags({ uv: !tamper.noUserVerification, at: false, synced })]),
				uint32(tamper.signCount ?? credential.signCount),
			);
			const signed = concat(authenticatorData, sha256Bytes(clientDataJSON));
			const keys = tamper.wrongKey ? await generateKeys(credential.algorithm) : credential.keys;
			return {
				id: base64url(credential.id),
				rawId: base64url(credential.id),
				type: "public-key",
				authenticatorAttachment: "platform",
				response: {
					clientDataJSON: base64url(clientDataJSON),
					authenticatorData: base64url(authenticatorData),
					signature: base64url(await sign(credential.algorithm, keys.privateKey, signed)),
					userHandle: credential.userHandle,
				},
				clientExtensionResults: {},
			};
		},
	};
}

/** The relying party id the test Install's admin uses: its hostname. */
export const TEST_RP_ID = TEST_ADMIN_HOST;

function clientData(type: string, challenge: string, origin: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/** Flags: user present (always), user verified, backup eligible and backed up (a synced passkey), attested data. */
function flags({ uv, at, synced }: { uv: boolean; at: boolean; synced: boolean }): number {
	return 0x01 | (uv ? 0x04 : 0) | (synced ? 0x08 | 0x10 : 0) | (at ? 0x40 : 0);
}

async function generateKeys(algorithm: PasskeyAlgorithm): Promise<CryptoKeyPair> {
	switch (algorithm) {
		case "ES256":
			return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
				"sign",
				"verify",
			])) as CryptoKeyPair;
		case "EdDSA":
			return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
		case "RS256":
			return (await crypto.subtle.generateKey(
				{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
				true,
				["sign", "verify"],
			)) as CryptoKeyPair;
	}
}

/** The credential's public key as a COSE key (RFC 9053), CBOR-encoded. */
async function coseKey(credential: StoredCredential): Promise<Uint8Array> {
	const jwk = await crypto.subtle.exportKey("jwk", credential.keys.publicKey);
	const bytes = (value: string | undefined) => new Uint8Array(Buffer.from(value ?? "", "base64url"));
	switch (credential.algorithm) {
		case "ES256":
			return encodeCbor(
				new Map<unknown, unknown>([
					[1, 2],
					[3, -7],
					[-1, 1],
					[-2, bytes(jwk.x)],
					[-3, bytes(jwk.y)],
				]),
			);
		case "EdDSA":
			return encodeCbor(
				new Map<unknown, unknown>([
					[1, 1],
					[3, -8],
					[-1, 6],
					[-2, bytes(jwk.x)],
				]),
			);
		case "RS256":
			return encodeCbor(
				new Map<unknown, unknown>([
					[1, 3],
					[3, -257],
					[-1, bytes(jwk.n)],
					[-2, bytes(jwk.e)],
				]),
			);
	}
}

/** Signs as an authenticator does: ECDSA signatures in ASN.1 DER, the others as they are. */
async function sign(algorithm: PasskeyAlgorithm, key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
	switch (algorithm) {
		case "ES256":
			return derSignature(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data)));
		case "EdDSA":
			return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, data));
		case "RS256":
			return new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, data));
	}
}

/** An ECDSA signature `r || s` as the DER `SEQUENCE { INTEGER r, INTEGER s }` WebAuthn carries. */
function derSignature(raw: Uint8Array): Uint8Array {
	const integer = (bytes: Uint8Array) => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		let value = bytes.slice(start);
		if ((value[0] ?? 0) & 0x80) value = concat(new Uint8Array([0]), value);
		return concat(new Uint8Array([0x02, value.length]), value);
	};
	const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return concat(new Uint8Array([0x30, body.length]), body);
}

/** A small CBOR encoder (RFC 8949): what WebAuthn uses, maps keeping their order. */
export function encodeCbor(value: unknown): Uint8Array {
	const head = (major: number, length: number) => {
		if (length < 24) return new Uint8Array([(major << 5) | length]);
		if (length < 256) return new Uint8Array([(major << 5) | 24, length]);
		if (length < 65536) return concat(new Uint8Array([(major << 5) | 25]), uint16(length));
		return concat(new Uint8Array([(major << 5) | 26]), uint32(length));
	};
	if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
	if (typeof value === "string") {
		const bytes = new TextEncoder().encode(value);
		return concat(head(3, bytes.length), bytes);
	}
	if (value instanceof Uint8Array) return concat(head(2, value.length), value);
	if (Array.isArray(value)) return concat(head(4, value.length), ...value.map(encodeCbor));
	if (value instanceof Map) {
		const parts: Uint8Array[] = [head(5, value.size)];
		for (const [key, entry] of value) parts.push(encodeCbor(key), encodeCbor(entry));
		return concat(...parts);
	}
	if (value === true) return new Uint8Array([0xf5]);
	if (value === false) return new Uint8Array([0xf4]);
	throw new Error(`Can't encode ${String(value)} as CBOR here.`);
}

function sha256(text: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(text).digest());
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function uint16(value: number): Uint8Array {
	return new Uint8Array([(value >> 8) & 255, value & 255]);
}

function uint32(value: number): Uint8Array {
	return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}
