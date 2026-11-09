import { type InstallConfig, isDevelopmentHostname } from "../config.ts";
import type { Dns } from "../dns.ts";
import { canonicalAddress, createGuardedFetch, GuardedFetchError, isPublicAddress } from "../guarded-fetch.ts";
import type { OutgoingHttp } from "../http.ts";
import type { TlsProbe } from "../tls.ts";
import type { DomainProblem } from "./domains.ts";

/**
 * The checks of a domain (ADR 0015): whether it reaches the Install (verification, and every hour once
 * verified) and whether it has a valid certificate (the Domain check).
 *
 * **What the Install calls.** Every request goes through the guarded fetcher: only `GET
 * http://<domain>/_webcraft/verify/<token>`, and once more over HTTPS when that is the one redirect it
 * answers (`https://<domain>/_webcraft/verify/<token>`, as Railway's edge and Coolify's proxy answer
 * plain HTTP); no other redirect is followed. A small answer, a short timeout,
 * and only to public addresses, or to the Install's own addresses (`WEBCRAFT_PUBLIC_ADDRESSES` and the
 * admin host's): a Site domain must point at the Install, which may sit on a private network or, in
 * development, on this machine. A domain resolving to any other internal address is never called, and
 * nothing it answers is shown to anyone: only whether it was the Install's own answer.
 */

/** Where the Install answers verification requests: `/_webcraft/verify/<token>`. */
export const VERIFY_PATH = "/_webcraft/verify/";

/** A certificate that runs out within this long makes the domain Unreachable. */
export const CERTIFICATE_WARNING_MS = 14 * 24 * 60 * 60_000;

/** The answer to a verification request is short: anything longer isn't the Install's. */
const MAX_ANSWER_BYTES = 1024;

const ANSWER_TIMEOUT_MS = 10_000;

export type CheckPorts = {
	config: Pick<InstallConfig, "adminHost" | "adminOrigin" | "publicAddresses">;
	http: OutgoingHttp;
	dns: Dns;
	tls: TlsProbe;
	signer: VerificationSigner;
};

/**
 * Makes and checks what verification exchanges, with a key derived from the Master key: each domain's
 * token (the last part of the path the Install fetches), and the answer to it, which names the domain.
 * Nobody without the Master key can make either, and neither is stored.
 */
export type VerificationSigner = {
	token(domain: { id: string; name: string }): Promise<string>;
	answer(name: string, token: string): Promise<string>;
};

export function createVerificationSigner(key: CryptoKey): VerificationSigner {
	const sign = async (text: string) =>
		Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))).toString("base64url");
	return {
		// A domain added again gets a new id, so a new token.
		token: async (domain) => (await sign(`domain-token:${domain.id}:${domain.name}`)).slice(0, 32),
		answer: (name, token) => sign(`domain-answer:${name}:${token}`),
	};
}

/** Whether two strings are equal, taking the same time wherever they differ. */
export function sameText(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	let difference = left.length ^ right.length;
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

/** What checking whether a domain reaches the Install found. */
export type ReachResult = {
	problem: Extract<DomainProblem, "dns" | "unreachable" | "response"> | null;
	/** The addresses the domain resolved to, already checked (empty when it didn't resolve). */
	addresses: string[];
};

/**
 * Whether a domain reaches this Install: it resolves, and `http://<domain>/_webcraft/verify/<token>`
 * answers exactly what only this Install makes for that token. A wrong or missing answer from a domain
 * that doesn't point at the Install's addresses is a DNS problem; from one that does, the answer's.
 */
export async function checkReaches(ports: CheckPorts, domain: { id: string; name: string }): Promise<ReachResult> {
	let addresses: string[];
	try {
		addresses = await ports.dns.resolve(domain.name);
	} catch {
		return { problem: "dns", addresses: [] };
	}
	if (addresses.length === 0) return { problem: "dns", addresses };
	const own = await installAddresses(ports);
	const ownSet = new Set(own.map(canonicalAddress));
	if (addresses.some((address) => !isPublicAddress(address) && !ownSet.has(canonicalAddress(address)))) {
		return { problem: "dns", addresses: [] };
	}
	const pointsHere = own.length === 0 || addresses.some((address) => ownSet.has(canonicalAddress(address)));
	const token = await ports.signer.token(domain);
	const guarded = createGuardedFetch({ http: ports.http, dns: ports.dns });
	const fetch = (url: string) =>
		guarded(new Request(url, { headers: { accept: "text/plain" } }), {
			allowedHosts: [domain.name],
			installAddresses: own,
			maxRedirects: 0,
			maxBytes: MAX_ANSWER_BYTES,
			timeoutMs: ANSWER_TIMEOUT_MS,
		});
	let answer: string;
	try {
		const url = `${verifyOrigin(ports.config, domain.name)}${VERIFY_PATH}${token}`;
		let response = await fetch(url);
		// A platform's proxy may answer plain HTTP only with the same address over HTTPS.
		const upgraded = `https://${domain.name}${VERIFY_PATH}${token}`;
		if (isRedirect(response.status) && locationOf(response, url) === upgraded) response = await fetch(upgraded);
		answer = response.status === 200 ? (await response.text()).trim() : "";
	} catch (error) {
		if (!(error instanceof GuardedFetchError)) throw error;
		if (error.problem === "address" || !pointsHere) return { problem: "dns", addresses };
		const silent = error.problem === "unreachable" || error.problem === "timeout";
		return { problem: silent ? "unreachable" : "response", addresses };
	}
	if (sameText(answer, await ports.signer.answer(domain.name, token))) return { problem: null, addresses };
	return { problem: pointsHere ? "response" : "dns", addresses };
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Where a redirect sends the request, as a full address; null when it says nowhere readable. */
function locationOf(response: Response, from: string): string | null {
	const location = response.headers.get("location");
	if (!location) return null;
	try {
		return new URL(location, from).href;
	} catch {
		return null;
	}
}

/** What the certificate check found, and when the certificate runs out. */
export type CertificateResult = {
	problem: Extract<DomainProblem, "certificate-missing" | "certificate-expiring"> | null;
	expiresAt: Date | null;
};

/**
 * Whether a domain answers HTTPS with a valid certificate that lasts at least 14 more days, asked at
 * one of the addresses it resolved to (already checked). Development names under `.localhost` are
 * served over plain HTTP and have none to check.
 */
export async function checkCertificate(
	ports: CheckPorts,
	name: string,
	addresses: readonly string[],
	now: Date,
): Promise<CertificateResult> {
	if (isDevelopmentHostname(name)) return { problem: null, expiresAt: null };
	const [address] = addresses;
	const certificate = address === undefined ? null : await ports.tls.certificate(name, address);
	if (!certificate?.trusted) return { problem: "certificate-missing", expiresAt: certificate?.expiresAt ?? null };
	const expiring = certificate.expiresAt.getTime() - now.getTime() < CERTIFICATE_WARNING_MS;
	return { problem: expiring ? "certificate-expiring" : null, expiresAt: certificate.expiresAt };
}

/**
 * The Install's own addresses: the public addresses it was given (`WEBCRAFT_PUBLIC_ADDRESSES`) and
 * those its admin host resolves to (a CNAME record to the admin host ends there).
 */
async function installAddresses(ports: Pick<CheckPorts, "config" | "dns">): Promise<string[]> {
	const resolved = await ports.dns.resolve(ports.config.adminHost).catch(() => [] as string[]);
	return [...new Set([...ports.config.publicAddresses, ...resolved])];
}

/**
 * Where a domain's verification request goes: plain HTTP, the way a new domain answers before it has
 * a certificate; for a development name under `.localhost`, on the web process's port.
 */
function verifyOrigin(config: Pick<InstallConfig, "adminHost" | "adminOrigin">, name: string): string {
	if (!isDevelopmentHostname(name) || !isDevelopmentHostname(config.adminHost)) return `http://${name}`;
	const port = new URL(config.adminOrigin).port;
	return `http://${name}${port ? `:${port}` : ""}`;
}
