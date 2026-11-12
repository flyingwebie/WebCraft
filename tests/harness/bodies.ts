// Request bodies as a client that doesn't say how long they are sends them (chunked transfer
// encoding): the web process learns a body's size only by reading it, so tests of body limits check
// how much of it was taken.

/** A body of `totalBytes` sent in chunks with no `Content-Length`; `taken()` is how much the server read. */
export type ChunkedBody = { body: ReadableStream<Uint8Array>; taken(): number };

/** A chunked body of `totalBytes` (the letter `a` over and over, or `chunk` repeated when given). */
export function chunkedBody(totalBytes: number, chunkBytes = 16 * 1024): ChunkedBody {
	let taken = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (taken >= totalBytes) {
					controller.close();
					return;
				}
				const size = Math.min(chunkBytes, totalBytes - taken);
				controller.enqueue(new Uint8Array(size).fill(97));
				taken += size;
			},
		},
		// Nothing is made ahead of what the server asks for.
		{ highWaterMark: 0 },
	);
	return { body, taken: () => taken };
}

/** A POST carrying a chunked body: no `Content-Length`, as chunked transfer encoding sends it. */
export function chunkedPost(url: string, headers: Record<string, string>, body: ReadableStream<Uint8Array>): Request {
	// A streamed body needs `duplex` in the Fetch standard; not every runtime's types know it yet.
	const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body, duplex: "half" };
	return new Request(url, init);
}
