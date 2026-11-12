/** The header a request's id goes back out in, on every answer. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * A new id for a request, which its log lines, the jobs it queues and its Error log entry carry:
 * always made here, never taken from the request. A proxy in front of the web process hands on the
 * headers a client sent, an `X-Request-Id` among them, so an id read from the request would be the
 * client's to choose: it could make its requests look like someone else's (an id copied from a
 * support thread), or flood one id. To line a proxy's own log up with WebCraft's, have the proxy log
 * the `X-Request-Id` of the answer.
 */
export function newRequestId(): string {
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
