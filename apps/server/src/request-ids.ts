import type { InstallConfig } from "@webcraft/core";

import { fromTrustedProxy } from "./client-address.ts";

/** The header a request id comes in from a trusted proxy, and goes back out in, on every answer. */
export const REQUEST_ID_HEADER = "x-request-id";

/** A request id a proxy may give: short, and only letters, digits and `.`, `_`, `:` and `-`. */
const PLAIN_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The id of a request, which its log lines and the jobs it queues carry: the one a trusted proxy in
 * front of the web process gave in `X-Request-Id`, when it gave a plain one, else a new random one.
 * Anyone else's is ignored: a client could make its requests look like someone else's.
 */
export function requestIdOf(request: Request, config: InstallConfig): string {
	const given = request.headers.get(REQUEST_ID_HEADER);
	if (given !== null && PLAIN_REQUEST_ID.test(given) && fromTrustedProxy(request, config)) return given;
	return crypto.randomUUID();
}

/** The answer with its request id in `X-Request-Id`, so a client can name it when it reports a problem. */
export function withRequestId(response: Response, requestId: string): Response {
	try {
		response.headers.set(REQUEST_ID_HEADER, requestId);
		return response;
	} catch {
		// Some answers' headers can't change (a redirect made by `Response.redirect`, a fetched answer).
		const headers = new Headers(response.headers);
		headers.set(REQUEST_ID_HEADER, requestId);
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	}
}
