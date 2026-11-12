import {
	type InstallServices,
	type OpenShareLink,
	RANGE_PRESETS,
	type RateLimitRule,
	REPORT_PAGE_POLICY,
	type ReportExplore,
	readLimitedBody,
	shareGonePage,
	sharePasswordPage,
} from "@webcraft/core";

import { clientAddress } from "../client-address.ts";
import { plainText } from "../responses.ts";
import { cookieValue, siteCookie, siteCookieName } from "./cookies.ts";

/**
 * The Share link address (#104): `share.<sites domain>`, the Install's own hostname for Share links,
 * never a Site's domain. `GET /<token>` shows the link's Dashboard, explored with `?range=` and the
 * filters (`country`, `device`, `source`, `page`), and nothing can be changed there; a link with a
 * password first shows a form posting to itself (`POST /<token>`), and the right password sets a
 * cookie for that link alone. A link unknown, revoked or expired answers the same page, so nobody
 * learns which links exist. Every answer is `noindex`, never kept, sends no `Referer` (the token is in
 * the address) and is limited per client address; password guesses are limited per link too.
 */

/** Page views a client address may ask for a minute, across every Share link. */
export const SHARE_PAGE_RATE_LIMIT: RateLimitRule = { limit: 120, windowMs: 60_000 };

/** Passwords a client address may try on one link a minute, as many as signing in. */
export const SHARE_PASSWORD_RATE_LIMIT: RateLimitRule = { limit: 10, windowMs: 60_000 };

/** Passwords anyone may try on one link an hour, from every address together: slows guessing from many. */
export const SHARE_PASSWORD_LINK_LIMIT: RateLimitRule = { limit: 50, windowMs: 60 * 60_000 };

/** Headers every answer here carries: never kept, never indexed, never sending its address on. */
const PRIVATE = {
	"cache-control": "private, no-store",
	"x-robots-tag": "noindex, nofollow",
	"referrer-policy": "no-referrer",
} as const;

/** The longest password form post read, in bytes. */
const PASSWORD_POST_MAX_BYTES = 4096;

/** Whether a hostname is the Share link address. */
export function isShareHost(services: InstallServices, hostname: string): boolean {
	return hostname === services.shareLinks.hostname();
}

/** Answers a request on the Share link address. */
export async function shareAnswer(services: InstallServices, request: Request): Promise<Response> {
	const url = new URL(request.url);
	const token = /^\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)?.[1];
	const address = clientAddress(request, services.config) ?? "unknown";
	if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
		return plainText(405, "Method Not Allowed", { allow: "GET, HEAD, POST", ...PRIVATE });
	}
	if (!(await services.rateLimits.count(`share:${address}`, SHARE_PAGE_RATE_LIMIT))) {
		return plainText(429, "Too many requests. Wait a minute, then try again.", {
			...PRIVATE,
			"retry-after": String(SHARE_PAGE_RATE_LIMIT.windowMs / 1000),
		});
	}
	const link = token ? await services.shareLinks.find(token) : null;
	if (!link) return page(request, shareGonePage("en"), 404);
	const cookieName = `share-${link.id.replaceAll("-", "")}`;
	if (request.method === "POST") return passwordPost(services, request, link, address, cookieName);
	if (link.passwordHash) {
		const cookie = cookieValue(request, siteCookieName(url.hostname, cookieName));
		if (!cookie || !(await services.shareLinks.passwordAccess(link, cookie))) {
			const answer = page(request, sharePasswordPage({ language: link.language, action: url.pathname }), 401);
			if (cookie) answer.headers.append("set-cookie", siteCookie(url.hostname, cookieName, "", 0));
			return answer;
		}
	}
	const html = await services.shareLinks.page(link, exploreOf(url.searchParams));
	if (!html) return page(request, shareGonePage(link.language), 404);
	// An open is the link followed as it was sent; exploring doesn't count again.
	if (request.method === "GET" && url.search === "") await services.shareLinks.opened(link);
	return page(request, html, 200);
}

/** What the page's explore form asked for; anything that isn't one of its values is left out. */
function exploreOf(params: URLSearchParams): ReportExplore {
	const range = params.get("range");
	const country = params.get("country")?.trim().toUpperCase() ?? "";
	const device = params.get("device");
	const source = params.get("source")?.trim().toLowerCase() ?? "";
	const path = params.get("page")?.trim() ?? "";
	return {
		range: (RANGE_PRESETS as readonly string[]).includes(range ?? "") ? (range as ReportExplore["range"]) : null,
		filters: {
			...(/^[A-Z]{2}$/.test(country) ? { country } : {}),
			...(device === "desktop" || device === "mobile" || device === "tablet" ? { device } : {}),
			...(source && source.length <= 200 ? { source } : {}),
			...(path.startsWith("/") && path.length <= 1000 ? { page: { path, match: "prefix" as const } } : {}),
		},
	};
}

/**
 * A Share link's password, given on its page: a form post from the address itself, limited per
 * client address and per link. The right one sets the link's cookie and goes back to its page.
 */
async function passwordPost(
	services: InstallServices,
	request: Request,
	link: OpenShareLink,
	address: string,
	cookieName: string,
): Promise<Response> {
	if (!fromItself(request)) return plainText(403, "Forbidden", PRIVATE);
	if (!link.passwordHash) return plainText(405, "Method Not Allowed", { allow: "GET, HEAD", ...PRIVATE });
	const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (type !== "application/x-www-form-urlencoded") return plainText(415, "Unsupported Media Type", PRIVATE);
	const body = await readLimitedBody(request, PASSWORD_POST_MAX_BYTES);
	if (body === null) return plainText(413, "Payload Too Large", PRIVATE);
	const perAddress = await services.rateLimits.count(`share-password:${link.id}:${address}`, SHARE_PASSWORD_RATE_LIMIT);
	const perLink =
		perAddress && (await services.rateLimits.count(`share-password:${link.id}`, SHARE_PASSWORD_LINK_LIMIT));
	if (!perAddress || !perLink) {
		const refused = page(
			request,
			sharePasswordPage({ language: link.language, action: new URL(request.url).pathname, problem: "tooMany" }),
			429,
		);
		refused.headers.set("retry-after", String(SHARE_PASSWORD_RATE_LIMIT.windowMs / 1000));
		return refused;
	}
	const access = await services.shareLinks.tryPassword(
		link,
		new URLSearchParams(new TextDecoder().decode(body)).get("password") ?? "",
	);
	if (!access) {
		const action = new URL(request.url).pathname;
		return page(request, sharePasswordPage({ language: link.language, action, problem: "wrong" }), 403);
	}
	const url = new URL(request.url);
	const maxAge = Math.max(0, Math.floor((access.expiresAt.getTime() - services.clock.now().getTime()) / 1000));
	const answer = new Response(null, { status: 303, headers: { location: url.pathname, ...PRIVATE } });
	answer.headers.append("set-cookie", siteCookie(url.hostname, cookieName, access.cookie, maxAge));
	return answer;
}

/** A page of the Share link address, with its policy and private headers. */
function page(request: Request, html: string, status: number): Response {
	return new Response(request.method === "HEAD" ? null : html, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": REPORT_PAGE_POLICY,
			...PRIVATE,
		},
	});
}

/**
 * Whether a post comes from the address's own page: the browser calls it same-origin, and its `Origin`
 * is the address. The page sends no referrer (its address holds the token), so browsers send
 * `Origin: null` with its form: then the browser's `Sec-Fetch-Site` alone says.
 */
function fromItself(request: Request): boolean {
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite !== null && fetchSite !== "same-origin") return false;
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") return fetchSite === "same-origin";
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		return false;
	}
}
