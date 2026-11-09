import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { pipeline, type Readable, type Transform } from "node:stream";
import { constants, createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import type { OutgoingHttp } from "./http.ts";
import { pinnedTarget } from "./http-pinned.ts";

/**
 * Outgoing HTTP for the worker, on Node. A call pinned to an address goes over `node:http`/`node:https`
 * to that address, with the URL's host name in the `Host` header and as the TLS server name, which
 * Node sends for SNI and checks the certificate against (never against the address). Kept connections are found again by address and port
 * (over TLS also by server name and trusted authorities), so a reused connection is one made to the
 * same address for the same name. The answer's body streams as it arrives, decoded as `fetch` decodes
 * it, and a pinned call never follows a redirect. Every other call is Node's `fetch`, as it is.
 *
 * `ca`: the certificate authorities pinned calls trust instead of the usual ones (tests trust one they
 * made with it).
 */
export function createNodeHttp(options: { ca?: string } = {}): OutgoingHttp {
	if (process.versions.bun) throw new Error("This outgoing HTTP runs on Node; the web process uses createBunHttp.");
	const agents = { http: new HttpAgent({ keepAlive: true }), https: new HttpsAgent({ keepAlive: true }) };
	return (request, call) =>
		call?.connectTo === undefined ? fetch(request) : pinnedCall(request, call.connectTo, agents, options.ca);
}

/** The headers Node's `fetch` adds when a request has none of its own. */
const FETCH_DEFAULTS = { accept: "*/*", "accept-encoding": "gzip, deflate, br", "user-agent": "node" };

async function pinnedCall(
	request: Request,
	address: string,
	agents: { http: HttpAgent; https: HttpsAgent },
	ca: string | undefined,
): Promise<Response> {
	const target = pinnedTarget(request.url, address);
	const headers: Record<string, string> = { ...FETCH_DEFAULTS };
	request.headers.forEach((value, name) => {
		headers[name] = value;
	});
	headers.host = target.host;
	const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
	const tls = {
		// Node checks the certificate against the server name: no name for an address, which is then
		// checked against that address. (A custom check would keep Node from reusing the connection.)
		servername: isIP(target.hostname) ? "" : target.hostname,
		...(ca ? { ca } : {}),
	};
	return new Promise((resolve, reject) => {
		const outgoing = (target.secure ? httpsRequest : httpRequest)(
			{
				host: address,
				port: target.port,
				path: `${target.url.pathname}${target.url.search}`,
				method: request.method,
				headers,
				signal: request.signal,
				agent: target.secure ? agents.https : agents.http,
				...(target.secure ? tls : {}),
			},
			(incoming) => {
				try {
					resolve(toResponse(incoming, request.method));
				} catch (error) {
					incoming.destroy();
					reject(error);
				}
			},
		);
		outgoing.on("error", reject);
		outgoing.end(body);
	});
}

/** Statuses whose answer has no body. */
const NO_BODY = new Set([101, 204, 205, 304]);

function toResponse(incoming: IncomingMessage, method: string): Response {
	const headers = new Headers();
	const raw = incoming.rawHeaders;
	for (let index = 0; index + 1 < raw.length; index += 2) headers.append(raw[index] ?? "", raw[index + 1] ?? "");
	const init = { status: incoming.statusCode ?? 0, statusText: incoming.statusMessage ?? "", headers };
	if (method === "HEAD" || NO_BODY.has(init.status)) {
		incoming.resume();
		return new Response(null, init);
	}
	return new Response(webStream(decoded(incoming)), init);
}

/** A Node stream as a web one, read a chunk at a time as the reader asks; cancelling it ends the Node stream. */
function webStream(readable: Readable): ReadableStream<Uint8Array> {
	const chunks: AsyncIterator<Uint8Array> = readable[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await chunks.next();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		async cancel() {
			await chunks.return?.();
		},
	});
}

/** Lenient as `fetch` is: an answer cut short still hands over what it decoded. */
const ZLIB_FLUSH = { flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH };
const BROTLI_FLUSH = { flush: constants.BROTLI_OPERATION_FLUSH, finishFlush: constants.BROTLI_OPERATION_FLUSH };

/** The body decoded from its `Content-Encoding` (gzip, deflate, br); as it came for any other. */
function decoded(incoming: IncomingMessage): Readable {
	const codings = (incoming.headers["content-encoding"] ?? "")
		.split(",")
		.map((coding) => coding.trim().toLowerCase())
		.filter((coding) => coding !== "" && coding !== "identity")
		.reverse();
	const decoders: Transform[] = [];
	for (const coding of codings) {
		if (coding === "gzip" || coding === "x-gzip") decoders.push(createGunzip(ZLIB_FLUSH));
		else if (coding === "deflate") decoders.push(createInflate(ZLIB_FLUSH));
		else if (coding === "br") decoders.push(createBrotliDecompress(BROTLI_FLUSH));
		else return incoming;
	}
	// An error in any step ends the body with that error, and a body ended early stops every step.
	return decoders.reduce<Readable>((stream, decoder) => pipeline(stream, decoder, () => {}), incoming);
}
