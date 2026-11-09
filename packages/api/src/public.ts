import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { type AnyProcedure, ORPCError, onError, type TraverseContractProcedureCallbackOptions } from "@orpc/server";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import {
	experimental_ZodSmartCoercionPlugin as ZodSmartCoercionPlugin,
	ZodToJsonSchemaConverter,
} from "@orpc/zod/zod4";
import {
	type ApiAccess,
	ApiTokenInvalidError,
	type ApiTokenUse,
	type InstallServices,
	type RateLimitTally,
} from "@webcraft/core";

import { exposureOf } from "./catalogue.ts";
import { type ApiContext, sensitiveActionOf } from "./context.ts";
import { adminRouter } from "./module-router.ts";
import { bodyWithinLimit, type RequestFacts } from "./rpc.ts";

/** Where the public Management API answers API tokens, on the admin host. */
export const PUBLIC_API_PREFIX = "/api/v1";

/** The OpenAPI document of `/api/v1`: every public procedure, with its input. */
export const OPENAPI_DOCUMENT_PATH = `${PUBLIC_API_PREFIX}/openapi.json`;

/** A public procedure, as the API serves it: a read or a write, and what it does. */
export type PublicProcedure = { access: ApiAccess; summary: string };

type Router = ReturnType<typeof adminRouter>;

/**
 * The public procedure at `path` (its router path, dotted), or null for an internal procedure or
 * none: WebCraft's own from the catalogue (`PROCEDURES`), and every Module procedure (`m.<id>.…`),
 * a read or write as its definition says (SDK 1.6; a write unless it says `read`).
 */
export function publicProcedure(services: InstallServices, path: readonly string[]): PublicProcedure | null {
	if (path[0] === "m") {
		const [, moduleId = "", ...rest] = path;
		const module = services.modules.registry.get(moduleId);
		const procedure = module?.runnable ? module.procedures.get(rest.join(".")) : undefined;
		if (!module || !procedure) return null;
		const name = (module.manifest ? Object.values(module.manifest.name)[0] : undefined) ?? module.id;
		return { access: procedure.kind ?? "write", summary: `${name}: ${rest.join(".")}.` };
	}
	const exposure = exposureOf(path.join("."));
	return exposure && exposure.access !== "internal" ? exposure : null;
}

/**
 * The public Management API (ADR 0029): every public procedure at `POST /api/v1/<path>` (its
 * router path with slashes: `/api/v1/entries/publish`, `/api/v1/m/redirects/rules/list`), its input
 * as a JSON body (multipart form data for uploads), its answer as JSON, its refusals as
 * `{ code, status, message, data }`. Every call carries an API token (`Authorization: Bearer …`)
 * and acts as its person within its limits, recorded in the Audit log as `via: token`; session
 * cookies are never read here. A token makes at most 300 requests a minute, 30 of them writes
 * (429 with `Retry-After`; `RateLimit-*` headers say what is left), and a read-only token calls
 * reads only. `GET /api/v1/openapi.json` is the OpenAPI document, open to anyone.
 *
 * Answers null for paths outside `/api/v1`.
 */
export function createPublicApi(
	services: InstallServices,
): (request: Request, facts: RequestFacts) => Promise<Response | null> {
	const handlers = new WeakMap<object, OpenAPIHandler<ApiContext>>();
	/** The handler for the Install's Modules now: a restarted Install may load other Modules. */
	const handlerFor = (router: Router) => {
		let handler = handlers.get(router);
		if (!handler) {
			handler = new OpenAPIHandler<ApiContext>(router, {
				filter: ({ path }) => publicProcedure(services, path) !== null,
				// Plain JSON has no dates: an input's dates come as ISO strings, read as the schema says.
				plugins: [new ResponseHeadersPlugin(), new ZodSmartCoercionPlugin()],
				clientInterceptors: [
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
		const { pathname } = new URL(request.url);
		if (pathname === OPENAPI_DOCUMENT_PATH) {
			if (request.method !== "GET" && request.method !== "HEAD")
				return refusal(405, "METHOD_NOT_SUPPORTED", "Use GET.", undefined, { allow: "GET, HEAD" });
			const document = await openApiDocument(services);
			return Response.json(document, { headers: { "cache-control": "no-cache" } });
		}
		if (pathname !== PUBLIC_API_PREFIX && !pathname.startsWith(`${PUBLIC_API_PREFIX}/`)) return null;

		let use: ApiTokenUse;
		try {
			use = await services.apiTokens.use(bearerToken(request.headers));
		} catch (error) {
			if (!(error instanceof ApiTokenInvalidError)) throw error;
			const headers: Record<string, string> = {
				"www-authenticate": `Bearer realm="WebCraft", error="${error.problem === "missing" ? "invalid_request" : "invalid_token"}"`,
			};
			if (error.retryAfterSeconds !== undefined) headers["retry-after"] = String(error.retryAfterSeconds);
			const data: Record<string, unknown> = { problem: error.problem };
			if (error.retryAfterSeconds !== undefined) data.retryAfterSeconds = error.retryAfterSeconds;
			return refusal(401, "TOKEN_INVALID", error.message, data, headers);
		}

		const path = pathname
			.slice(PUBLIC_API_PREFIX.length + 1)
			.split("/")
			.filter(Boolean);
		const procedure = publicProcedure(services, path);
		const access: ApiAccess = procedure?.access ?? "read";
		const { requests, writes } = await services.apiTokens.count(use.token.id, use.token.readOnly ? "read" : access);
		const limits = rateLimitHeaders(services, [requests, writes]);
		if (!requests.within || (writes && !writes.within)) {
			const retryAfterSeconds = retryAfter(services, !requests.within ? requests : (writes ?? requests));
			return refusal(
				429,
				"TOO_MANY_REQUESTS",
				!requests.within
					? `This API token made ${requests.limit} requests this minute: wait, then try again.`
					: `This API token made ${writes?.limit ?? 0} writes this minute: wait, then try again.`,
				{ retryAfterSeconds, limit: !requests.within ? "requests" : "writes" },
				{ ...limits, "retry-after": String(retryAfterSeconds) },
			);
		}
		if (!procedure) return refusal(404, "NOT_FOUND", "There is no such public procedure.", undefined, limits);
		if (request.method !== "POST") {
			return refusal(405, "METHOD_NOT_SUPPORTED", "Call procedures with POST.", undefined, {
				...limits,
				allow: "POST",
			});
		}
		if (access === "write" && use.token.readOnly) {
			return refusal(
				403,
				"TOKEN_READ_ONLY",
				"This API token is read-only: it can't call procedures that change anything.",
				undefined,
				limits,
			);
		}

		const body = await bodyWithinLimit(services, request, path.join("."));
		if (body instanceof Response) return withHeaders(body, limits);
		const { matched, response } = await handlerFor(adminRouter(services)).handle(body.request, {
			prefix: PUBLIC_API_PREFIX,
			context: { services, headers: request.headers, clientAddress, via: use.access.via, token: use },
		});
		if (!matched) return refusal(404, "NOT_FOUND", "There is no such public procedure.", undefined, limits);
		if (body.overflowed()) return withHeaders(body.tooLarge(), limits);
		return withHeaders(response, { ...limits, "cache-control": "no-store" });
	};
}

/** The token in `Authorization: Bearer <token>`, or null when there is none. */
function bearerToken(headers: Headers): string | null {
	const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "");
	return match?.[1] ?? null;
}

/** A refusal, shaped as the procedures' own: `{ defined, code, status, message, data }`. */
function refusal(
	status: number,
	code: string,
	message: string,
	data: Record<string, unknown> | undefined,
	headers: Record<string, string> = {},
): Response {
	return Response.json(
		{ defined: false, code, status, message, data },
		{ status, headers: { "cache-control": "no-store", ...headers } },
	);
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
	for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
	return response;
}

function retryAfter(services: InstallServices, tally: RateLimitTally): number {
	return Math.max(1, Math.ceil((tally.resetsAt.getTime() - services.clock.now().getTime()) / 1000));
}

/** What is left of the limit closest to running out, as `RateLimit-Limit`, `-Remaining` and `-Reset` (seconds). */
function rateLimitHeaders(
	services: InstallServices,
	tallies: readonly (RateLimitTally | null)[],
): Record<string, string> {
	const counted = tallies.filter((tally): tally is RateLimitTally => tally !== null);
	const [tightest] = counted.toSorted((a, b) => a.remaining - b.remaining);
	if (!tightest) return {};
	return {
		"ratelimit-limit": String(tightest.limit),
		"ratelimit-remaining": String(tightest.remaining),
		"ratelimit-reset": String(retryAfter(services, tightest)),
	};
}

const documents = new WeakMap<object, Promise<Record<string, unknown>>>();

/**
 * The OpenAPI 3.1 document of `/api/v1` for the Install's Modules: every public procedure as
 * `POST /<path>`, its operation id the dotted path (`entries.publish`), tagged by its group, with
 * its summary and input schema, and WebCraft's own marks for the MCP server and the CLI:
 * `x-webcraft-access` (`read` or `write`), `x-webcraft-sensitive` (the Sensitive action: never
 * callable with an API token) and `x-webcraft-confirmation` (two steps: a preview and a
 * `confirmation` id, valid 5 minutes).
 */
export function openApiDocument(services: InstallServices): Promise<Record<string, unknown>> {
	const router = adminRouter(services);
	let document = documents.get(router);
	if (!document) {
		document = generateDocument(services, router);
		documents.set(router, document);
		document.catch(() => documents.delete(router));
	}
	return document;
}

async function generateDocument(services: InstallServices, router: Router): Promise<Record<string, unknown>> {
	const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
	const procedures = new Map<string, AnyProcedure>();
	const filter = ({ contract, path }: TraverseContractProcedureCallbackOptions) => {
		if (publicProcedure(services, path) === null) return false;
		procedures.set(path.join("."), contract as AnyProcedure);
		return true;
	};
	const document = (await generator.generate(router, {
		info: {
			title: "WebCraft Management API",
			version: "1",
			description:
				"Every public procedure of the Management API. Call each with POST and an API token (`Authorization: Bearer <token>`), made under Your account › API tokens in the admin.",
		},
		servers: [{ url: PUBLIC_API_PREFIX }],
		security: [{ apiToken: [] }],
		components: { securitySchemes: { apiToken: { type: "http", scheme: "bearer" } } },
		filter,
	})) as unknown as { paths?: Record<string, Record<string, Record<string, unknown>>> };

	for (const operations of Object.values(document.paths ?? {})) {
		for (const operation of Object.values(operations)) {
			const path = String(operation.operationId ?? "");
			const procedure = procedures.get(path);
			const found = publicProcedure(services, path.split("."));
			if (!procedure || !found) continue;
			const parts = path.split(".");
			operation.summary = found.summary;
			operation.tags = [parts[0] === "m" ? `m.${parts[1]}` : (parts[0] ?? path)];
			operation["x-webcraft-access"] = found.access;
			const action = sensitiveActionOf(procedure["~orpc"].middlewares);
			if (action) operation["x-webcraft-sensitive"] = action;
			if (takesConfirmation(procedure)) operation["x-webcraft-confirmation"] = true;
		}
	}
	return document as Record<string, unknown>;
}

/** Whether a procedure's input takes a `confirmation` id: it works in two steps. */
function takesConfirmation(procedure: AnyProcedure): boolean {
	const shape = (procedure["~orpc"].inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
	return shape !== undefined && "confirmation" in shape;
}
