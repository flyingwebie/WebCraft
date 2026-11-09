import { isIP } from "node:net";

import type { OutgoingHttp } from "./http.ts";
import { pinnedTarget } from "./http-pinned.ts";

/** Bun's own `fetch` options for TLS (which Node's `fetch` doesn't have). */
type BunFetchInit = RequestInit & { tls?: { serverName?: string; ca?: string } };

/**
 * Outgoing HTTP for the web process and server commands, on Bun. A call pinned to an address goes to
 * that address as the URL's host (`https://203.0.113.10/…`), with the URL's host name in the `Host`
 * header and as Bun's TLS `serverName`, which Bun sends for SNI and checks the certificate against
 * (never against the address). Bun keeps a connection for reuse per address and server name, so a
 * reused connection is one made to the same address for the same name. A pinned call never follows a
 * redirect. Every other call is Bun's `fetch`, as it is.
 *
 * `ca`: the certificate authorities pinned calls trust instead of the usual ones (tests trust one they
 * made with it).
 */
export function createBunHttp(options: { ca?: string } = {}): OutgoingHttp {
	if (!process.versions.bun) throw new Error("This outgoing HTTP runs on Bun; the worker uses createNodeHttp.");
	return async (request, call) => {
		if (call?.connectTo === undefined) return fetch(request);
		const { url, hostname, host } = pinnedTarget(request.url, call.connectTo);
		const headers = new Headers(request.headers);
		headers.set("host", host);
		const init: BunFetchInit = {
			method: request.method,
			headers,
			body: request.body === null ? null : await request.arrayBuffer(),
			redirect: "manual",
			signal: request.signal,
			// No server name for an address: the certificate is then checked against that address.
			tls: { ...(isIP(hostname) ? {} : { serverName: hostname }), ...(options.ca ? { ca: options.ca } : {}) },
		};
		return fetch(url, init);
	};
}
