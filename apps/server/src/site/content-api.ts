import {
	CONTENT_API_BASE,
	CONTENT_API_LIMITS,
	type ContentApiDoor,
	ContentApiError,
	carriesKey,
	contentApiDocument,
	type InstallServices,
	type RateLimitTally,
	type SiteHost,
} from "@webcraft/core";

import { clientAddress } from "../client-address.ts";
import { matchesETag } from "../media-response.ts";
import type { PageCache } from "./page-cache.ts";

/** Where the Content API is on every Site hostname (ADR 0029): `/_content/v1/…`, the major version in the path. */
export const CONTENT_API_PATH = "/_content";

/** Whether a path is the Content API's (any version: an unknown one answers its own 404). */
export function isContentApiPath(pathname: string): boolean {
	return pathname === CONTENT_API_PATH || pathname.startsWith(`${CONTENT_API_PATH}/`);
}

/**
 * Answers may be kept by browsers and CDNs, but must be checked with the Site each time (it answers
 * 304 while the ETag holds): a publish changes them at once, and every request's key is checked.
 */
const ANSWER_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/** How long a browser may keep a preflight's answer before asking again: 10 minutes. */
const PREFLIGHT_MAX_AGE = "600";

/** What a browser's script may read of an answer besides the simple headers. */
const EXPOSED_HEADERS = "ETag, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After";

/**
 * The Content API on a Site's hostname (ADR 0029): read-only JSON of the Site's published content
 * for frontends built elsewhere, on its domains and its Staging address alike. It never shows Drafts,
 * so the Staging address's sign-in doesn't apply: a Content key of the Site is what opens it.
 *
 * In order: only `GET`, `HEAD` and `OPTIONS` (a CORS preflight, answered for the origins the Site's
 * working keys list); the Site must have it on; each request counts against its client address's
 * limit (120 a minute per Site); a key in the query string is refused; the key must be the Site's
 * and working; a browser on another site must be at an origin the key lists; then the key's own
 * limit (600 a minute) and its daily use. Answers carry a strong ETag (304 for `If-None-Match`),
 * kept in the page cache under the Site's page cache generation, so every publish clears them.
 */
export async function contentApiAnswer(
	services: InstallServices,
	cache: PageCache,
	request: Request,
	host: SiteHost,
): Promise<Response> {
	const url = new URL(request.url);
	const origin = request.headers.get("origin");
	const cors = new Cors(origin, url.origin);
	try {
		if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
			throw new ContentApiError(
				"METHOD_NOT_ALLOWED",
				"The Content API answers GET and HEAD only.",
				{ method: request.method },
				{ allow: "GET, HEAD, OPTIONS" },
			);
		}
		const door = await services.contentApi.open(host);
		if (!door) {
			throw new ContentApiError(
				"CONTENT_API_OFF",
				"This Site's Content API is switched off. Staff switch it on under Site settings › Content API.",
			);
		}
		cors.door = door;
		if (request.method === "OPTIONS") return await preflight(request, cors);
		const address = clientAddress(request, services.config) ?? "unknown";
		const byAddress = await services.rateLimits.tally(
			`content-api:${host.site.id}:${address}`,
			CONTENT_API_LIMITS.address,
		);
		if (!byAddress.within) throw tooMany("address", byAddress, services);
		const base = `${CONTENT_API_BASE}/`;
		if (url.pathname !== CONTENT_API_BASE && !url.pathname.startsWith(base)) {
			throw new ContentApiError(
				"NOT_FOUND",
				"There is no such path in the Content API: version 1 is at /_content/v1/.",
			);
		}
		const segments = url.pathname
			.slice(base.length)
			.split("/")
			.filter((segment) => segment !== "")
			.map((segment) => safeDecode(segment));
		// The API's own reference needs no key: it is the same for every Site.
		if (segments.length === 1 && segments[0] === "openapi.json") {
			return await answer(
				services,
				request,
				cors,
				cache,
				host,
				"openapi",
				() => ({ body: contentApiDocument(), keep: true }),
				[byAddress],
			);
		}
		if (carriesKey(url.searchParams)) {
			throw new ContentApiError(
				"CONTENT_KEY_IN_QUERY",
				"Send the Content key in the Authorization header (`Authorization: Bearer <key>`), never in the address, where logs keep it.",
			);
		}
		const found = await door.key(bearerOf(request));
		if (!found.ok) {
			throw new ContentApiError(
				"CONTENT_KEY_INVALID",
				found.problem === "missing"
					? "Send a Content key of this Site: `Authorization: Bearer <key>`."
					: found.problem === "revoked"
						? "This Content key was revoked. Ask the Site's Staff for a new one."
						: "This Content key isn't one of this Site's.",
				{ problem: found.problem },
				{ "www-authenticate": 'Bearer realm="content"' },
			);
		}
		cors.key = found.origins;
		if (origin !== null && !cors.allowedByKey()) {
			throw new ContentApiError(
				"ORIGIN_NOT_ALLOWED",
				"This Content key isn't for pages at this origin. Staff list the origins a key may be used from.",
				{ origin },
			);
		}
		const byKey = await services.rateLimits.tally(`content-key:${found.id}`, CONTENT_API_LIMITS.key);
		await door.noteUse(found);
		if (!byKey.within) throw tooMany("key", byKey, services);
		return await answer(
			services,
			request,
			cors,
			cache,
			host,
			`${url.pathname}?${normalisedQuery(url.searchParams)}`,
			() => door.read(segments, url.searchParams),
			[byAddress, byKey],
		);
	} catch (error) {
		if (error instanceof ContentApiError) return await refusal(request, cors, error);
		throw error;
	}
}

/** A path segment decoded (`%20` as a space); as it is when it isn't valid percent-encoding. */
function safeDecode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/** The query string in one order, so the same query is kept once whatever order its parameters came in. */
function normalisedQuery(params: URLSearchParams): string {
	return [...params]
		.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
		.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
		.join("&");
}

/** What `Authorization` sends as a key: its bearer value, or (any other way) the header as it is, which no key matches; null without one. */
function bearerOf(request: Request): string | null {
	const header = request.headers.get("authorization")?.trim();
	if (!header) return null;
	return /^Bearer\s+\S+$/i.test(header) ? header.replace(/^Bearer\s+/i, "") : header;
}

/**
 * Who may read an answer in a browser (CORS): the page's own origin always; pages at an origin the
 * request's key lists; before the key is known (a preflight, or a refusal of the key), pages at an
 * origin any working key of the Site lists, so a frontend can read why it was refused.
 */
class Cors {
	door: ContentApiDoor | null = null;
	key: readonly string[] | null = null;
	readonly origin: string | null;
	private readonly own: string;
	constructor(origin: string | null, own: string) {
		this.origin = origin;
		this.own = own;
	}

	allowedByKey(): boolean {
		return this.origin === null || this.origin === this.own || (this.key?.includes(this.origin) ?? false);
	}

	/** The headers that let the request's page read the answer, when it may. */
	async headers(): Promise<Record<string, string>> {
		const vary = { vary: "Origin, Authorization" };
		if (this.origin === null) return vary;
		const allowed =
			this.origin === this.own ||
			(this.key !== null ? this.key.includes(this.origin) : ((await this.door?.allowsOrigin(this.origin)) ?? false));
		return allowed
			? { ...vary, "access-control-allow-origin": this.origin, "access-control-expose-headers": EXPOSED_HEADERS }
			: vary;
	}
}

/**
 * A CORS preflight: a browser asks whether a page at its origin may send `GET` with `Authorization`.
 * It carries no key, so it is answered for the origins any working key of the Site lists; the request
 * that follows is checked against its own key's.
 */
async function preflight(request: Request, cors: Cors): Promise<Response> {
	const origin = request.headers.get("origin");
	const method = request.headers.get("access-control-request-method");
	if (origin === null || method === null) {
		throw new ContentApiError(
			"METHOD_NOT_ALLOWED",
			"OPTIONS is a CORS preflight: send Origin and Access-Control-Request-Method.",
			undefined,
			{
				allow: "GET, HEAD, OPTIONS",
			},
		);
	}
	const headers = await cors.headers();
	if (!headers["access-control-allow-origin"]) {
		throw new ContentApiError("ORIGIN_NOT_ALLOWED", "No Content key of this Site is for pages at this origin.", {
			origin,
		});
	}
	return new Response(null, {
		status: 204,
		headers: {
			...headers,
			"access-control-allow-methods": "GET, HEAD",
			"access-control-allow-headers": "Authorization, If-None-Match",
			"access-control-max-age": PREFLIGHT_MAX_AGE,
			"cache-control": "no-store",
		},
	});
}

/** Past a limit: 429 with `Retry-After` until its window ends. */
function tooMany(limit: "key" | "address", tally: RateLimitTally, services: InstallServices): ContentApiError {
	const seconds = Math.max(1, Math.ceil((tally.resetsAt.getTime() - services.clock.now().getTime()) / 1000));
	return new ContentApiError(
		"TOO_MANY_REQUESTS",
		limit === "key"
			? `Too many requests with this Content key: at most ${tally.limit} a minute. Try again in ${seconds} seconds.`
			: `Too many requests from this address: at most ${tally.limit} a minute. Try again in ${seconds} seconds.`,
		{ limit },
		{ "retry-after": String(seconds), ...rateLimitHeaders([tally], services) },
	);
}

/** `RateLimit-*` headers of the limit closest to running out. */
function rateLimitHeaders(tallies: readonly RateLimitTally[], services: InstallServices): Record<string, string> {
	const [closest] = [...tallies].sort((a, b) => a.remaining / a.limit - b.remaining / b.limit);
	if (!closest) return {};
	return {
		"ratelimit-limit": String(closest.limit),
		"ratelimit-remaining": String(closest.remaining),
		"ratelimit-reset": String(
			Math.max(0, Math.ceil((closest.resetsAt.getTime() - services.clock.now().getTime()) / 1000)),
		),
	};
}

/**
 * An answer of the API: from the page cache when it holds it, else read and kept (under the Site's
 * page cache generation, so a publish retires it). Its ETag is the SHA-256 of its JSON; a request
 * whose `If-None-Match` holds it gets 304.
 */
async function answer(
	services: InstallServices,
	request: Request,
	cors: Cors,
	cache: PageCache,
	host: SiteHost,
	key: string,
	read: () => Promise<{ body: unknown; keep: boolean }> | { body: unknown; keep: boolean },
	tallies: readonly RateLimitTally[],
): Promise<Response> {
	const cacheKey = `content-api ${host.origin}${key}`;
	let kept = cache.get(host.site.id, host.cacheGeneration, cacheKey, services.clock.now());
	const hit = kept !== undefined;
	if (!kept) {
		const { body, keep } = await read();
		const json = JSON.stringify(body);
		kept = { html: json, etag: await etagOf(json), headers: {} };
		if (keep) cache.set(host.site.id, host.cacheGeneration, cacheKey, kept, { variant: key.includes("=") });
	}
	const headers: Record<string, string> = {
		"content-type": "application/json; charset=utf-8",
		"cache-control": ANSWER_CACHE_CONTROL,
		etag: kept.etag,
		"x-content-type-options": "nosniff",
		"x-robots-tag": "noindex",
		"x-cache": hit ? "HIT" : "MISS",
		...(await cors.headers()),
		...rateLimitHeaders(tallies, services),
	};
	if (matchesETag(request.headers.get("if-none-match"), kept.etag)) return new Response(null, { status: 304, headers });
	return new Response(request.method === "HEAD" ? null : kept.html, { status: 200, headers });
}

/** A refusal as JSON, never kept by anyone. */
async function refusal(request: Request, cors: Cors, error: ContentApiError): Promise<Response> {
	return new Response(request.method === "HEAD" ? null : JSON.stringify(error.body()), {
		status: error.status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-robots-tag": "noindex",
			...(await cors.headers()),
			...error.headers,
		},
	});
}

/** A strong ETag: the SHA-256 of the JSON, in base64url. */
async function etagOf(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return `"${Buffer.from(digest).toString("base64url")}"`;
}
