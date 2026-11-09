import {
	EDIT_MODE_PATH,
	type InstallServices,
	isEditPath,
	RateLimitedError,
	type SiteHost,
	STAGING_ENTER_PATH,
	STAGING_PAGE_POLICY,
	STAGING_PASSWORD_PATH,
	STAGING_PASSWORD_RATE_LIMIT,
	STAGING_PATH,
	STAGING_STYLESHEET,
	stagingPage,
} from "@webcraft/core";

import { clientAddress } from "../client-address.ts";
import { matchesETag } from "../media-response.ts";
import { plainText } from "../responses.ts";
import { cookieValue, siteCookie, siteCookieName } from "./cookies.ts";
import { clearEditCookie, editSessionOf } from "./edit-mode.ts";

/**
 * The Staging address (ADR 0014): a Site on the agency's own domain, showing it with all its Drafts
 * to the people reviewing it, and to nobody else. Every request on it needs one of:
 *
 * - the Staging cookie (`webcraft.staging`): someone signed in to the admin who sees the Site opened
 *   it from there, through a single-use link (`/_webcraft/staging/enter`), as Edit mode is opened. It
 *   is checked again on every request: the admin session it came from, the person's access;
 * - the password cookie (`webcraft.staging-password`): someone gave the Site's staging password on
 *   the page below, within the week, and the password hasn't changed since;
 * - an edit cookie that still holds (Edit mode on a Site with no domain lives on its Staging address).
 *
 * Everyone else gets a page asking them to sign in (and, when the Site has a staging password, to
 * give it), for every path. Only the Install's own ways in answer without one: the link, the password
 * form, the page's stylesheet (`/_wc/staging/page-<hash>.css`), and Edit mode's paths, which check
 * their own cookie.
 */

/** The Staging cookie: one browser's Staging session. */
const STAGING_COOKIE = "staging";

/** The cookie the staging password sets. */
const PASSWORD_COOKIE = "staging-password";

/** How long the page's stylesheet may be kept: it is named by its hash. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Headers every answer of the Staging address's own paths carries: never kept, never indexed. */
const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex" } as const;

/** The longest password form post read, in bytes. */
const PASSWORD_POST_MAX_BYTES = 4096;

/**
 * Answers the Staging address's own paths (`/_webcraft/staging/…`); null for every other path, and on
 * every hostname that isn't a Staging address.
 */
export async function stagingEndpoint(
	services: InstallServices,
	request: Request,
	host: SiteHost,
): Promise<Response | null> {
	if (host.address !== "staging") return null;
	const url = new URL(request.url);
	if (url.pathname === STAGING_STYLESHEET.path) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return plainText(405, "Method Not Allowed", { allow: "GET, HEAD", ...PRIVATE });
		}
		const etag = `"${STAGING_STYLESHEET.path.slice(STAGING_STYLESHEET.path.lastIndexOf("-") + 1, -".css".length)}"`;
		const headers = {
			"cache-control": IMMUTABLE,
			etag,
			"x-robots-tag": "noindex",
			"x-content-type-options": "nosniff",
		};
		if (matchesETag(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
		return new Response(request.method === "HEAD" ? null : STAGING_STYLESHEET.css, {
			headers: { "content-type": "text/css; charset=utf-8", ...headers },
		});
	}
	if (!url.pathname.startsWith(STAGING_PATH)) return null;
	if (url.pathname === STAGING_ENTER_PATH) {
		if (request.method !== "GET") return plainText(405, "Method Not Allowed", { allow: "GET", ...PRIVATE });
		return enter(services, request, host, url.searchParams.get("token") ?? "");
	}
	if (url.pathname === STAGING_PASSWORD_PATH) {
		if (request.method !== "POST") return plainText(405, "Method Not Allowed", { allow: "POST", ...PRIVATE });
		return passwordPost(services, request, host);
	}
	return plainText(404, "Not Found", PRIVATE);
}

/**
 * Whether a request on a Staging address may see the Site: a Staging cookie, a password cookie or an
 * edit cookie that holds. Answers null when it may, and otherwise what it gets instead: the page
 * asking to sign in, clearing any of those cookies that no longer open anything. Other hostnames,
 * and Edit mode's own paths, always may.
 */
export async function stagingRefusal(
	services: InstallServices,
	request: Request,
	host: SiteHost,
): Promise<Response | null> {
	if (host.address !== "staging") return null;
	const url = new URL(request.url);
	if (url.pathname.startsWith(EDIT_MODE_PATH)) return null;
	const stale: string[] = [];
	const session = cookieValue(request, siteCookieName(url.hostname, STAGING_COOKIE));
	if (session) {
		if (await services.staging.session(host, session)) return null;
		stale.push(siteCookie(url.hostname, STAGING_COOKIE, "", 0));
	}
	const password = cookieValue(request, siteCookieName(url.hostname, PASSWORD_COOKIE));
	if (password) {
		if (await services.staging.passwordAccess(host, password)) return null;
		stale.push(siteCookie(url.hostname, PASSWORD_COOKIE, "", 0));
	}
	const edit = await editSessionOf(services, request, host);
	if (edit.session) return null;
	if (edit.stale) stale.push(clearEditCookie(request));
	const refusal =
		request.method === "GET" || request.method === "HEAD"
			? await signInPage(services, request, host, 403)
			: plainText(403, "Forbidden", PRIVATE);
	for (const line of stale) refusal.headers.append("set-cookie", line);
	return refusal;
}

/**
 * The page the Staging address shows someone it doesn't know: in the language of the path asked
 * for, with a link to sign in through the admin (back at that path) and, when the Site has a staging
 * password, a form to give it.
 */
async function signInPage(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	status: number,
	options: { path?: string; problem?: "wrongPassword" | "tooMany" } = {},
): Promise<Response> {
	const url = new URL(request.url);
	const path = options.path ?? (isEditPath(url.pathname) && !url.pathname.startsWith("/_") ? url.pathname : "/");
	const language = await services.sitePages.languageAt(host, path);
	const signIn = new URL(`/staging/${host.site.id}`, services.config.adminOrigin);
	signIn.searchParams.set("path", path);
	const html = stagingPage({
		language: language.code,
		direction: language.direction,
		siteName: host.site.name,
		signInUrl: signIn.toString(),
		path,
		passwordForm: await services.staging.hasPassword(host.site),
		problem: options.problem,
	});
	const body = request.method === "HEAD" ? null : html;
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": STAGING_PAGE_POLICY,
			"referrer-policy": "same-origin",
			...PRIVATE,
		},
	});
}

/**
 * Follows a link from the admin: uses it up, sets the Staging cookie and sends the browser on to the
 * page, so the link's token never stays in the address bar or the history. A link that doesn't work
 * (used, expired, another Site's) says so plainly.
 */
async function enter(services: InstallServices, request: Request, host: SiteHost, token: string): Promise<Response> {
	const headers = { "referrer-policy": "no-referrer", ...PRIVATE };
	try {
		// The link holds a token, so trying links is limited like signing in.
		await services.rateLimits.hit("auth", clientAddress(request, services.config));
	} catch (error) {
		if (!(error instanceof RateLimitedError)) throw error;
		return plainText(429, "Too many attempts. Wait a moment, then try again.", {
			...headers,
			"retry-after": String(error.retryAfterSeconds),
		});
	}
	const entered = token ? await services.staging.enter(host, token) : null;
	if (!entered) {
		return plainText(
			403,
			"This link has expired or was used already. Open the site again from where you sign in.",
			headers,
		);
	}
	const hostname = new URL(request.url).hostname;
	const maxAge = Math.max(0, Math.floor((entered.expiresAt.getTime() - services.clock.now().getTime()) / 1000));
	const answer = new Response(null, {
		status: 303,
		headers: { location: entered.path, ...headers, "cache-control": "no-store" },
	});
	answer.headers.append("set-cookie", siteCookie(hostname, STAGING_COOKIE, entered.cookie, maxAge));
	return answer;
}

/**
 * The staging password, given on the page above: a form post from the Staging address itself, limited
 * per client address. The right password sets the password cookie and goes on to the page asked for;
 * a wrong one shows the page again saying so.
 */
async function passwordPost(services: InstallServices, request: Request, host: SiteHost): Promise<Response> {
	if (!fromStagingPages(request)) return plainText(403, "Forbidden", PRIVATE);
	if (!(await services.staging.hasPassword(host.site))) return plainText(404, "Not Found", PRIVATE);
	const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (type !== "application/x-www-form-urlencoded") return plainText(415, "Unsupported Media Type", PRIVATE);
	const body = await readLimited(request, PASSWORD_POST_MAX_BYTES);
	if (body === null) return plainText(413, "Payload Too Large", PRIVATE);
	const form = new URLSearchParams(body);
	const given = form.get("path") ?? "/";
	const path = isEditPath(given) && !given.startsWith("/_") ? given : "/";
	const address = clientAddress(request, services.config) ?? "unknown";
	if (!(await services.rateLimits.count(`staging-password:${host.site.id}:${address}`, STAGING_PASSWORD_RATE_LIMIT))) {
		const refused = await signInPage(services, request, host, 429, { path, problem: "tooMany" });
		refused.headers.set("retry-after", String(STAGING_PASSWORD_RATE_LIMIT.windowMs / 1000));
		return refused;
	}
	const access = await services.staging.tryPassword(host, form.get("password") ?? "");
	if (!access) return signInPage(services, request, host, 403, { path, problem: "wrongPassword" });
	const hostname = new URL(request.url).hostname;
	const maxAge = Math.max(0, Math.floor((access.expiresAt.getTime() - services.clock.now().getTime()) / 1000));
	const answer = new Response(null, {
		status: 303,
		headers: { location: path, ...PRIVATE, "cache-control": "no-store" },
	});
	answer.headers.append("set-cookie", siteCookie(hostname, PASSWORD_COOKIE, access.cookie, maxAge));
	return answer;
}

/**
 * Whether a post comes from the Staging address's own pages: its `Origin` is the Staging address,
 * and the browser (when it says) calls it same-origin.
 */
function fromStagingPages(request: Request): boolean {
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite !== null && fetchSite !== "same-origin") return false;
	const origin = request.headers.get("origin");
	if (!origin) return fetchSite === "same-origin";
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		return false;
	}
}

/** A request's body as text, or null when it is longer than `limit` bytes. */
async function readLimited(request: Request, limit: number): Promise<string | null> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > limit) return null;
	const bytes = new Uint8Array(await request.arrayBuffer());
	return bytes.byteLength > limit ? null : new TextDecoder().decode(bytes);
}
