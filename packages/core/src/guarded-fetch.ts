import { isIP } from "node:net";

import type { Dns } from "./dns.ts";
import type { OutgoingHttp } from "./http.ts";

/**
 * The guarded fetcher: how WebCraft calls hosts that someone else chose (a Module's outside hosts,
 * later Import from URL, Webhooks and the WordPress import). On top of outgoing HTTP it:
 *
 * - calls only `http` and `https` URLs without credentials in them, on the hosts allowed;
 * - resolves the host first and refuses loopback, private, link-local and other addresses that
 *   aren't on the public internet, then does the same after every redirect;
 * - follows at most 3 redirects (none for calls that carry a secret);
 * - gives up after a timeout, and refuses answers larger than a limit, reading the body in full.
 *
 * Outgoing HTTP resolves the name again when it connects; an HTTP adapter that connects to the
 * checked address (with Node's `lookup` hook) closes that gap in the worker.
 */
export type GuardedFetch = (request: Request, options: GuardedFetchOptions) => Promise<Response>;

export type GuardedFetchOptions = {
	/** The host names that may be called, in lower case. */
	allowedHosts: readonly string[];
	/** At most 3. */
	maxRedirects?: number;
	timeoutMs?: number;
	maxBytes?: number;
};

export const GUARDED_FETCH_LIMITS = {
	maxRedirects: 3,
	timeoutMs: 10_000,
	maxTimeoutMs: 30_000,
	maxBytes: 5 * 1024 * 1024,
	maxMaxBytes: 20 * 1024 * 1024,
};

/**
 * Why the guarded fetcher refused or gave up on a call:
 * - `scheme`: not an http or https URL, or one with credentials in it;
 * - `host`: a host that isn't allowed;
 * - `address`: a host that resolves to an address inside the server's network (or doesn't resolve);
 * - `redirects`: more redirects than allowed;
 * - `timeout`: no full answer in time;
 * - `size`: an answer larger than allowed;
 * - `unreachable`: the host didn't answer.
 */
export type GuardedFetchProblem = "scheme" | "host" | "address" | "redirects" | "timeout" | "size" | "unreachable";

export class GuardedFetchError extends Error {
	override name = "GuardedFetchError";
	readonly problem: GuardedFetchProblem;
	constructor(problem: GuardedFetchProblem, message: string, options?: ErrorOptions) {
		super(message, options);
		this.problem = problem;
	}
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function createGuardedFetch({ http, dns }: { http: OutgoingHttp; dns: Dns }): GuardedFetch {
	return async (request, options) => {
		const maxRedirects = Math.min(
			options.maxRedirects ?? GUARDED_FETCH_LIMITS.maxRedirects,
			GUARDED_FETCH_LIMITS.maxRedirects,
		);
		const timeoutMs = Math.min(options.timeoutMs ?? GUARDED_FETCH_LIMITS.timeoutMs, GUARDED_FETCH_LIMITS.maxTimeoutMs);
		const maxBytes = Math.min(options.maxBytes ?? GUARDED_FETCH_LIMITS.maxBytes, GUARDED_FETCH_LIMITS.maxMaxBytes);
		const allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new GuardedFetchError("timeout", `No answer within ${timeoutMs} ms.`)),
			timeoutMs,
		);
		const aborted = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
		});
		aborted.catch(() => {});
		try {
			// The body is read once, so a redirect that keeps it (307, 308) can send it again.
			const body = request.body === null ? null : await request.arrayBuffer();
			let hop = { url: new URL(request.url), method: request.method, headers: new Headers(request.headers), body };
			for (let redirects = 0; ; redirects++) {
				await Promise.race([checkTarget(hop.url, allowed, dns), aborted]);
				let response: Response;
				try {
					response = await Promise.race([
						http(
							new Request(hop.url.toString(), {
								method: hop.method,
								headers: hop.headers,
								body: hop.body,
								redirect: "manual",
								signal: controller.signal,
							}),
						),
						aborted,
					]);
				} catch (error) {
					if (error instanceof GuardedFetchError) throw error;
					throw new GuardedFetchError("unreachable", `${hop.url.host} didn't answer.`, { cause: error });
				}
				const location = response.headers.get("location");
				if (!REDIRECTS.has(response.status) || location === null) {
					return await Promise.race([readLimited(response, maxBytes), aborted]);
				}
				await response.body?.cancel();
				if (redirects >= maxRedirects) {
					throw new GuardedFetchError("redirects", `More than ${maxRedirects} redirects, starting at ${request.url}.`);
				}
				hop = redirected(hop, new URL(location, hop.url), response.status);
			}
		} finally {
			clearTimeout(timer);
		}
	};
}

async function checkTarget(url: URL, allowed: ReadonlySet<string>, dns: Dns): Promise<void> {
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
		throw new GuardedFetchError(
			"scheme",
			`Only http and https addresses without credentials are called, not ${url.protocol}.`,
		);
	}
	const host = url.hostname.toLowerCase();
	if (!allowed.has(host)) throw new GuardedFetchError("host", `${host} isn't one of the hosts that may be called.`);
	const literal = host.startsWith("[") ? host.slice(1, -1) : host;
	let addresses: string[];
	if (isIP(literal)) {
		addresses = [literal];
	} else {
		try {
			addresses = await dns.resolve(host);
		} catch (error) {
			throw new GuardedFetchError("address", `${host} doesn't resolve.`, { cause: error });
		}
	}
	if (addresses.length === 0) throw new GuardedFetchError("address", `${host} doesn't resolve.`);
	const internal = addresses.find((address) => !isPublicAddress(address));
	if (internal !== undefined) {
		throw new GuardedFetchError("address", `${host} resolves to ${internal}, inside the server's network.`);
	}
}

type Hop = { url: URL; method: string; headers: Headers; body: ArrayBuffer | null };

/** The request to send after a redirect: 303, and 301/302 after a POST, become a GET without a body. */
function redirected(hop: Hop, url: URL, status: number): Hop {
	const toGet = status === 303 || ((status === 301 || status === 302) && hop.method === "POST");
	if (!toGet) return { ...hop, url };
	const headers = new Headers(hop.headers);
	headers.delete("content-type");
	headers.delete("content-length");
	return { url, method: "GET", headers, body: null };
}

/** The response, with its body read in full: refused once it grows past `maxBytes`. */
async function readLimited(response: Response, maxBytes: number): Promise<Response> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel();
		throw new GuardedFetchError("size", `The answer is larger than ${maxBytes} bytes.`);
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (response.body) {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new GuardedFetchError("size", `The answer is larger than ${maxBytes} bytes.`);
			}
			chunks.push(value);
		}
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const empty = response.status === 204 || response.status === 304 || response.status === 205;
	return new Response(empty ? null : body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * Whether an address is on the public internet: not loopback, private, link-local, shared (CGNAT),
 * multicast, reserved, documentation or benchmarking space, in IPv4 or IPv6 (including IPv4 inside
 * IPv6 and NAT64).
 */
export function isPublicAddress(address: string): boolean {
	if (isIP(address) === 4) return isPublicIPv4(address);
	if (isIP(address) !== 6) return false;
	const words = ipv6Words(address);
	if (!words) return false;
	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = words;
	// IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
	const embedded = `${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`;
	if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) {
		return f === 0 && g === 0 && h <= 1 ? false : isPublicIPv4(embedded);
	}
	if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isPublicIPv4(embedded);
	if ((a & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
	if ((a & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
	if ((a & 0xffc0) === 0xfec0) return false; // site-local fec0::/10
	if ((a & 0xff00) === 0xff00) return false; // multicast ff00::/8
	if (a === 0x2001 && b === 0x0db8) return false; // documentation 2001:db8::/32
	if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false; // discard 100::/64
	if (a === 0x2001 && b < 0x0200) return false; // IETF protocol assignments 2001::/23
	if (a === 0x2002) return isPublicIPv4(`${b >> 8}.${b & 255}.${c >> 8}.${c & 255}`); // 6to4
	return (a & 0xe000) === 0x2000; // global unicast 2000::/3
}

function isPublicIPv4(address: string): boolean {
	const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 100 && b >= 64 && b <= 127) return false; // shared address space
	if (a === 169 && b === 254) return false; // link-local
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF and TEST-NET-1
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
	if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
	if (a >= 224) return false; // multicast, reserved and broadcast
	return true;
}

/** The eight 16-bit words of an IPv6 address, or null when it can't be read. */
function ipv6Words(address: string): number[] | null {
	let text = address.toLowerCase().split("%")[0] ?? "";
	const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted?.[1]) {
		const [p = 0, q = 0, r = 0, s = 0] = dotted[1].split(".").map(Number);
		text = `${text.slice(0, -dotted[1].length)}${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const words = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((word) =>
		Number.parseInt(word, 16),
	);
	return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
		? words
		: null;
}
