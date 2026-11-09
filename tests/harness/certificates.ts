import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { isIPv4 } from "node:net";

/** A certificate and its private key, both PEM, as a TLS server takes them. */
export type TestCertificate = { cert: string; key: string };

/** What a certificate is valid for: host names, and IP addresses. */
export type CertificateNames = { hosts?: readonly string[]; addresses?: readonly string[] };

/**
 * A certificate authority made in the test, never trusted by anything but the clients a test hands
 * `cert` to (as their `ca`). It issues server certificates for made-up names such as `pinned.test`,
 * valid from an hour ago for a day, with ECDSA P-256 keys.
 */
export type TestCertificateAuthority = {
	/** The authority's own certificate, PEM: what a client trusts. */
	readonly cert: string;
	/** A server certificate for the names, signed by this authority. */
	issue(names: CertificateNames): TestCertificate;
};

export function createTestCertificateAuthority(name = "WebCraft test authority"): TestCertificateAuthority {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const keyId = keyIdentifier(publicKey);
	const cert = certificate({
		subject: name,
		issuer: name,
		publicKey,
		signer: privateKey,
		extensions: [
			extension(OID.basicConstraints, true, sequence(boolean(true))),
			extension(OID.keyUsage, true, bitString(Uint8Array.of(0x06), 1)), // keyCertSign, cRLSign
			extension(OID.subjectKeyIdentifier, false, octetString(keyId)),
		],
	});
	return {
		cert,
		issue({ hosts = [], addresses = [] }) {
			const leaf = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
			const alternativeNames = [
				...hosts.map((host) => tagged(0x82, new TextEncoder().encode(host))),
				...addresses.map((address) => tagged(0x87, addressBytes(address))),
			];
			return {
				cert: certificate({
					subject: hosts[0] ?? addresses[0] ?? "test server",
					issuer: name,
					publicKey: leaf.publicKey,
					signer: privateKey,
					extensions: [
						extension(OID.basicConstraints, true, sequence()),
						extension(OID.keyUsage, true, bitString(Uint8Array.of(0x80), 7)), // digitalSignature
						extension(OID.extendedKeyUsage, false, sequence(objectIdentifier(OID.serverAuth))),
						extension(OID.subjectAltName, false, sequence(...alternativeNames)),
						extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(leaf.publicKey))),
						extension(OID.authorityKeyIdentifier, false, sequence(tagged(0x80, keyId))),
					],
				}),
				key: leaf.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			};
		},
	};
}

const OID = {
	ecdsaWithSha256: "1.2.840.10045.4.3.2",
	commonName: "2.5.4.3",
	subjectKeyIdentifier: "2.5.29.14",
	keyUsage: "2.5.29.15",
	subjectAltName: "2.5.29.17",
	basicConstraints: "2.5.29.19",
	authorityKeyIdentifier: "2.5.29.35",
	extendedKeyUsage: "2.5.29.37",
	serverAuth: "1.3.6.1.5.5.7.3.1",
};

const HOUR = 60 * 60_000;

/** An X.509 v3 certificate, DER-encoded by hand and signed with ECDSA over SHA-256, as PEM. */
function certificate(options: {
	subject: string;
	issuer: string;
	publicKey: KeyObject;
	signer: KeyObject;
	extensions: Uint8Array[];
}): string {
	const now = Date.now();
	const serial = randomBytes(16);
	serial[0] = (serial[0] ?? 0) & 0x7f; // a positive number
	const algorithm = sequence(objectIdentifier(OID.ecdsaWithSha256));
	const toBeSigned = sequence(
		tagged(0xa0, integer(Uint8Array.of(2))), // version 3
		integer(serial),
		algorithm,
		distinguishedName(options.issuer),
		sequence(utcTime(new Date(now - HOUR)), utcTime(new Date(now + 24 * HOUR))),
		distinguishedName(options.subject),
		new Uint8Array(options.publicKey.export({ type: "spki", format: "der" })),
		tagged(0xa3, sequence(...options.extensions)),
	);
	const signature = new Uint8Array(sign("sha256", toBeSigned, options.signer));
	const der = sequence(toBeSigned, algorithm, bitString(signature, 0));
	const base64 = Buffer.from(der).toString("base64");
	return `-----BEGIN CERTIFICATE-----\n${base64.replace(/(.{64})/g, "$1\n").trimEnd()}\n-----END CERTIFICATE-----\n`;
}

function keyIdentifier(publicKey: KeyObject): Uint8Array {
	return new Uint8Array(
		createHash("sha1")
			.update(publicKey.export({ type: "spki", format: "der" }))
			.digest(),
	);
}

function addressBytes(address: string): Uint8Array {
	if (isIPv4(address)) return Uint8Array.from(address.split(".").map(Number));
	const [head = "", tail = ""] = address.split("::");
	const words = (part: string) => (part ? part.split(":").map((word) => Number.parseInt(word, 16)) : []);
	const front = words(head);
	const back = words(tail);
	const all = [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
	return Uint8Array.from(all.flatMap((word) => [word >> 8, word & 0xff]));
}

function distinguishedName(commonName: string): Uint8Array {
	return sequence(set(sequence(objectIdentifier(OID.commonName), utf8String(commonName))));
}

function extension(oid: string, critical: boolean, value: Uint8Array): Uint8Array {
	return sequence(objectIdentifier(oid), ...(critical ? [boolean(true)] : []), octetString(value));
}

// DER: a tag, the length of the contents, then the contents.

function tagged(tag: number, contents: Uint8Array): Uint8Array {
	const length = contents.length;
	const lengthBytes: number[] = [];
	if (length < 0x80) lengthBytes.push(length);
	else {
		for (let rest = length; rest > 0; rest >>= 8) lengthBytes.unshift(rest & 0xff);
		lengthBytes.unshift(0x80 | lengthBytes.length);
	}
	const out = new Uint8Array(1 + lengthBytes.length + length);
	out[0] = tag;
	out.set(lengthBytes, 1);
	out.set(contents, 1 + lengthBytes.length);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

const sequence = (...items: Uint8Array[]) => tagged(0x30, concat(items));
const set = (...items: Uint8Array[]) => tagged(0x31, concat(items));
const boolean = (value: boolean) => tagged(0x01, Uint8Array.of(value ? 0xff : 0));
const octetString = (bytes: Uint8Array) => tagged(0x04, bytes);
const utf8String = (text: string) => tagged(0x0c, new TextEncoder().encode(text));
const bitString = (bytes: Uint8Array, unusedBits: number) => tagged(0x03, concat([Uint8Array.of(unusedBits), bytes]));

function integer(bytes: Uint8Array): Uint8Array {
	// A leading zero keeps a number whose first bit is set positive.
	return tagged(0x02, (bytes[0] ?? 0) & 0x80 ? concat([Uint8Array.of(0), bytes]) : bytes);
}

function objectIdentifier(dotted: string): Uint8Array {
	const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
	const bytes = [first * 40 + second];
	for (const arc of rest) {
		const base128 = [arc & 0x7f];
		for (let value = arc >> 7; value > 0; value >>= 7) base128.unshift((value & 0x7f) | 0x80);
		bytes.push(...base128);
	}
	return tagged(0x06, Uint8Array.from(bytes));
}

function utcTime(date: Date): Uint8Array {
	const iso = date.toISOString(); // 2026-11-09T12:34:56.789Z
	const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
	return tagged(0x17, new TextEncoder().encode(text));
}
