import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import {
	CSV_LIMITS,
	csvTooLarge,
	IMPORT_PART_BYTES,
	ImportUploadRefusedError,
	type InstallServices,
	limitBody,
	MediaTooLargeError,
	SiteImportUploadRefusedError,
} from "@webcraft/core";

import type { ApiContext } from "./context.ts";
import { logUnexpectedFailure, toApiError } from "./errors.ts";

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
						logUnexpectedFailure(services, error, path);
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
		// An upload is read only from someone signed in: its limit is the largest file the Install takes,
		// far more than anyone else may make the web process hold, and nobody else has one to send.
		if (isUpload(request) && !(await services.auth.session({ headers: request.headers, clientAddress })).session) {
			return refused(new ORPCError("UNAUTHORIZED", { message: "Sign in first." }));
		}
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
export const MULTIPART_ALLOWANCE = 64 * 1024;

/**
 * The largest body a request without a file may have. Every procedure's input is far smaller: the
 * largest, a design's history, is a string of 8 million characters, 24 MB at most as JSON.
 */
export const API_BODY_MAX_BYTES = 32 * 1024 * 1024;

export type LimitedBody = { request: Request; overflowed(): boolean; tooLarge(): Response };

/** The procedures whose uploads aren't Media, with the largest file each takes and how it refuses a larger one. */
const OWN_UPLOAD_LIMITS: Record<string, { maxFileBytes: number; refusal: () => Error }> = {
	"imports.uploadCsv": { maxFileBytes: CSV_LIMITS.maxBytes, refusal: csvTooLarge },
	// A Module source's file comes in parts of at most IMPORT_PART_BYTES each, never in one body.
	// A Site export comes in parts of at most IMPORT_PART_BYTES too.
	"siteImports.uploadPart": {
		maxFileBytes: IMPORT_PART_BYTES,
		refusal: () =>
			new SiteImportUploadRefusedError("part", `A part has at most ${IMPORT_PART_BYTES} bytes.`, {
				bytes: IMPORT_PART_BYTES,
			}),
	},
	"imports.uploadPart": {
		maxFileBytes: IMPORT_PART_BYTES,
		refusal: () =>
			new ImportUploadRefusedError("part", `A part has at most ${IMPORT_PART_BYTES} bytes.`, {
				bytes: IMPORT_PART_BYTES,
			}),
	},
};

/**
 * Keeps a request's body to what the procedure at `procedurePath` (dotted) takes, before it is read
 * into memory: an upload (a multipart body, the only kind that carries files) to its largest file
 * (the Install's largest Media file, unless the procedure has its own limit), and any other body to
 * `API_BODY_MAX_BYTES` (`PAYLOAD_TOO_LARGE`). A body that says it is larger is refused at once, and
 * one that doesn't say stops being read once it passes the limit. Its callers check who sends an
 * upload first (`/api/v1` its token, the admin's API its session).
 */
export async function bodyWithinLimit(
	services: InstallServices,
	request: Request,
	procedurePath: string,
): Promise<LimitedBody | Response> {
	const multipart = isUpload(request);
	let limit = API_BODY_MAX_BYTES;
	let refusal: () => Error = payloadTooLarge;
	if (multipart) {
		const own = Object.hasOwn(OWN_UPLOAD_LIMITS, procedurePath) ? OWN_UPLOAD_LIMITS[procedurePath] : undefined;
		const maxFileBytes = own?.maxFileBytes ?? (await services.settings.media()).maxFileBytes;
		limit = maxFileBytes + MULTIPART_ALLOWANCE;
		refusal = own?.refusal ?? (() => new MediaTooLargeError(maxFileBytes));
	}
	const limited = limitBody(request, limit, refusal);
	if ("refused" in limited) return refused(limited.refused);
	return { ...limited, tooLarge: () => refused(refusal()) };
}

/** How a body without a file over `API_BODY_MAX_BYTES` is refused (`PAYLOAD_TOO_LARGE`, 413). */
export function payloadTooLarge(): ORPCError<"PAYLOAD_TOO_LARGE", { maxBytes: number }> {
	return new ORPCError("PAYLOAD_TOO_LARGE", {
		status: 413,
		message: `A request without a file has at most ${API_BODY_MAX_BYTES} bytes.`,
		data: { maxBytes: API_BODY_MAX_BYTES },
	});
}

/** Whether a request carries an upload: a multipart body, the only kind that carries files. */
function isUpload(request: Request): boolean {
	return request.headers.get("content-type")?.toLowerCase().startsWith("multipart/") ?? false;
}

/** A request refused before its procedure ran (`MEDIA_TOO_LARGE`, `UNAUTHORIZED`), as a procedure answers it. */
function refused(error: Error): Response {
	const answer = toApiError(error);
	const { code, status, message, data } = answer instanceof ORPCError ? answer : new ORPCError("PAYLOAD_TOO_LARGE");
	return Response.json(
		{ json: { defined: false, code, status, message, data } },
		{ status, headers: { "cache-control": "no-store" } },
	);
}
