/**
 * How much of a request's body the web process reads. A client need not say how long its body is
 * (chunked transfer encoding), so a limit holds only where the body is read: every reader here counts
 * as it reads and stops at its limit, whatever `Content-Length` said.
 *
 * - Every request the web handler answers comes under one ceiling (`underBodyCeiling`,
 *   `DEFAULT_BODY_MAX_BYTES`), so a route that reads its body with no limit of its own is still bounded.
 * - A route says what it takes by how it reads: `readLimitedBody` (the bytes, or null past the limit)
 *   or `limitBody` (the request again, its body failing past the limit). Its own limit then counts in
 *   place of the ceiling: smaller for the posts anyone may send, larger for uploads, which a route
 *   reads only once it knows who sends them. (`bodyLimitedByRoute` for a library that counts itself.)
 */

/** The largest body of a request whose route sets no limit of its own, in bytes. */
export const DEFAULT_BODY_MAX_BYTES = 1024 * 1024;

/** A request's body passed the ceiling it was read under. */
export class BodyTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`The request's body is larger than ${maxBytes} bytes.`);
		this.name = "BodyTooLargeError";
	}
}

type Ceiling = { limit: number; overflowed: boolean };

/** The ceiling each request the web handler wrapped is read under. */
const CEILINGS = new WeakMap<Request, Ceiling>();

/**
 * The request with its body under a ceiling of `limit` bytes: read past it (or said to be longer,
 * which is believed before a byte is read) the body fails with `BodyTooLargeError`, and
 * `bodyOverflowed` says so. Nothing is read until the route reads. The web handler does this once,
 * for every request; a request without a body is answered as it is.
 */
export function underBodyCeiling(request: Request, limit: number = DEFAULT_BODY_MAX_BYTES): Request {
	if (request.body === null) return request;
	const ceiling: Ceiling = { limit, overflowed: false };
	const declared = Number(request.headers.get("content-length"));
	const reader = request.body.getReader();
	let started = false;
	let read = 0;
	const counted = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const refuse = () => {
					ceiling.overflowed = true;
					// Not waited for: a body cancelled half-read may never say it is done (Bun's never does).
					reader.cancel().catch(() => {});
					controller.error(new BodyTooLargeError(ceiling.limit));
				};
				// What the request says of its length is believed before a byte is read.
				if (!started && Number.isFinite(declared) && declared > ceiling.limit) return refuse();
				started = true;
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}
				read += value.byteLength;
				if (read > ceiling.limit) return refuse();
				controller.enqueue(value);
			},
			cancel: (reason) => reader.cancel(reason),
		},
		// Nothing is read ahead of the route: it may set its own limit first.
		{ highWaterMark: 0 },
	);
	// A streamed body needs `duplex` in the Fetch standard; not every runtime's types know it yet.
	const init: RequestInit & { duplex: "half" } = {
		method: request.method,
		headers: request.headers,
		body: counted,
		signal: request.signal,
		duplex: "half",
	};
	const limited = new Request(request.url, init);
	CEILINGS.set(limited, ceiling);
	return limited;
}

/** Whether a request's body was cut off at the ceiling it came under: its route's answer is then 413. */
export function bodyOverflowed(request: Request): boolean {
	return CEILINGS.get(request)?.overflowed ?? false;
}

/**
 * Says a route keeps the request's body to a limit of its own, which takes the ceiling's place.
 * `readLimitedBody` and `limitBody` say so themselves; a route calls this only when something else
 * that counts as it reads will read the body (a library with its own limit).
 */
export function bodyLimitedByRoute(request: Request): void {
	const ceiling = CEILINGS.get(request);
	if (ceiling) ceiling.limit = Number.POSITIVE_INFINITY;
}

/**
 * A request's body, when it is at most `limit` bytes: by what the request says of its length first,
 * then by what comes, reading no further than the limit. Null when it is larger.
 */
export async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
	bodyLimitedByRoute(request);
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > limit) {
		// Not waited for, here and below: a body cancelled half-read may never say it is done.
		request.body?.cancel().catch(() => {});
		return null;
	}
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Keeps a request's body to `limit` bytes before it is read into memory: a body that says it is
 * larger is refused at once (`refused`), and one that doesn't say stops being read once it passes the
 * limit, its reading failing with `refusal()` (`overflowed()` then says so). For what reads a request
 * itself (a procedure's input, a form with a file).
 */
export function limitBody(
	request: Request,
	limit: number,
	refusal: () => Error,
): { request: Request; overflowed(): boolean } | { refused: Error } {
	bodyLimitedByRoute(request);
	if (request.body === null) return { request, overflowed: () => false };
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) {
		// Not waited for: a body cancelled half-read may never say it is done (Bun's never does).
		request.body.cancel().catch(() => {});
		return { refused: refusal() };
	}
	const reader = request.body.getReader();
	let read = 0;
	let overflowed = false;
	const counted = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			read += value.byteLength;
			if (read > limit) {
				overflowed = true;
				reader.cancel().catch(() => {});
				controller.error(refusal());
				return;
			}
			controller.enqueue(value);
		},
		cancel: (reason) => reader.cancel(reason),
	});
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	// A streamed body needs `duplex` in the Fetch standard; not every runtime's types know it yet.
	const init: RequestInit & { duplex: "half" } = {
		method: request.method,
		headers,
		body: counted,
		signal: request.signal,
		duplex: "half",
	};
	return { request: new Request(request.url, init), overflowed: () => overflowed };
}
