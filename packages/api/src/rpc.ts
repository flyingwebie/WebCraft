import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import {
	CSV_LIMITS,
	csvTooLarge,
	IMPORT_PART_BYTES,
	ImportUploadRefusedError,
	type InstallServices,
	MediaTooLargeError,
} from "@webcraft/core";

import type { ApiContext } from "./context.ts";
import { toApiError } from "./errors.ts";

import { adminRouter } from "./module-router.ts";

/** Where the admin calls the Management API, on the admin host. */
export const ADMIN_API_PREFIX = "/api/rpc";

/** What the web process knows about a request besides the request itself. */
export type RequestFacts = {
	/** The address of the client it came from (`clientAddress` in the web process), or null. */
	clientAddress: string | null;
};

/**
 * The Management API as the admin's own pages call it (oRPC's RPC protocol), signed in with the
 * session cookie. Answers null for paths outside `/api/rpc`.
 */
export function createAdminApi(
	services: InstallServices,
): (request: Request, facts: RequestFacts) => Promise<Response | null> {
	const handlers = new WeakMap<object, RPCHandler<ApiContext>>();
	/** The handler for the Install's Modules now: a restarted Install may load other Modules. */
	const handlerFor = () => {
		const router = adminRouter(services);
		let handler = handlers.get(router);
		if (!handler) {
			handler = new RPCHandler<ApiContext>(router, {
				plugins: [new ResponseHeadersPlugin()],
				clientInterceptors: [
					// Refusals (bad input, no session, a wrong token) are answers; anything else is a failure to log.
					// The caller only gets a plain 500.
					onError((error, { path }) => {
						if (error instanceof ORPCError && error.status < 500) return;
						services.log.error("A Management API call failed unexpectedly", { error, procedure: path.join(".") });
					}),
				],
			});
			handlers.set(router, handler);
		}
		return handler;
	};
	return async (request, { clientAddress }) => {
		const handler = handlerFor();
		const procedurePath = new URL(request.url).pathname.slice(ADMIN_API_PREFIX.length + 1).replaceAll("/", ".");
		const body = await bodyWithinLimit(services, request, procedurePath);
		if (body instanceof Response) return body;
		const { matched, response } = await handler.handle(body.request, {
			prefix: ADMIN_API_PREFIX,
			context: { services, headers: request.headers, clientAddress, via: { kind: "admin" } },
		});
		if (!matched) return null;
		// A body that grew past the limit while it was read is refused as too large, not as malformed.
		if (body.overflowed()) return body.tooLarge();
		response.headers.set("cache-control", "no-store");
		return response;
	};
}

/** Room a multipart body needs beside its file: boundaries, part headers and the other fields. */
const MULTIPART_ALLOWANCE = 64 * 1024;

export type LimitedBody = { request: Request; overflowed(): boolean; tooLarge(): Response };

/** The procedures whose uploads aren't Media, with the largest file each takes and how it refuses a larger one. */
const OWN_UPLOAD_LIMITS: Record<string, { maxFileBytes: number; refusal: () => Error }> = {
	"imports.uploadCsv": { maxFileBytes: CSV_LIMITS.maxBytes, refusal: csvTooLarge },
	// A Module source's file comes in parts of at most IMPORT_PART_BYTES each, never in one body.
	"imports.uploadPart": {
		maxFileBytes: IMPORT_PART_BYTES,
		refusal: () =>
			new ImportUploadRefusedError("part", `A part has at most ${IMPORT_PART_BYTES} bytes.`, {
				bytes: IMPORT_PART_BYTES,
			}),
	},
};

/**
 * Keeps an upload (a multipart body, the only kind that carries files) to the largest file the
 * procedure at `procedurePath` (dotted) takes (the Install's largest Media file, unless it has its
 * own limit), before it is read into memory: a body that says it is larger is refused at once, and
 * one that doesn't say stops being read once it passes the limit.
 */
export async function bodyWithinLimit(
	services: InstallServices,
	request: Request,
	procedurePath: string,
): Promise<LimitedBody | Response> {
	const multipart = request.headers.get("content-type")?.toLowerCase().startsWith("multipart/") ?? false;
	if (!multipart || request.body === null) {
		return { request, overflowed: () => false, tooLarge: () => tooLarge(new MediaTooLargeError(0)) };
	}
	const own = Object.hasOwn(OWN_UPLOAD_LIMITS, procedurePath) ? OWN_UPLOAD_LIMITS[procedurePath] : undefined;
	const maxFileBytes = own?.maxFileBytes ?? (await services.settings.media()).maxFileBytes;
	const refusal = own?.refusal ?? (() => new MediaTooLargeError(maxFileBytes));
	const limit = maxFileBytes + MULTIPART_ALLOWANCE;
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) {
		// Not waited for: a body cancelled half-read may never say it is done (Bun's never does).
		request.body.cancel().catch(() => {});
		return tooLarge(refusal());
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
	return {
		request: new Request(request.url, init),
		overflowed: () => overflowed,
		tooLarge: () => tooLarge(refusal()),
	};
}

/** A refused upload (`MEDIA_TOO_LARGE`, `IMPORT_FILE_REFUSED`), as a procedure answers it. */
function tooLarge(error: Error): Response {
	const answer = toApiError(error);
	const { code, status, message, data } = answer instanceof ORPCError ? answer : new ORPCError("PAYLOAD_TOO_LARGE");
	return Response.json(
		{ json: { defined: false, code, status, message, data } },
		{ status, headers: { "cache-control": "no-store" } },
	);
}
