import { type InstallServices, LANGUAGE_CHOICE_PATH, type SiteHost } from "@webcraft/core";

import { plainText } from "../responses.ts";
import { cookieValue, siteCookie, siteCookieName } from "./cookies.ts";

/**
 * A Site's languages on its own domain (ADR 0010): the Language switcher's links remember the
 * visitor's choice in a cookie, without JavaScript.
 */

/** The cookie the language a visitor chose is kept in: `webcraft.language`, for a year. */
export const LANGUAGE_COOKIE = "language";
const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * A Language switcher link, `/_wc/lang/<path>`: remembers the language of the path in the language
 * cookie and sends the visitor on to the path (303, never kept). Any path that isn't one on the Site
 * is a plain 404, so a link can't send anyone elsewhere. Null for any other path.
 */
export async function languageChoiceResponse(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	headers: Record<string, string>,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== LANGUAGE_CHOICE_PATH && !url.pathname.startsWith(`${LANGUAGE_CHOICE_PATH}/`)) return null;
	const choice = await services.sitePages.languageChoice(host, url.pathname);
	if (!choice) return plainText(404, "Not Found", headers);
	return new Response(null, {
		status: 303,
		headers: {
			location: choice.location,
			"cache-control": "no-store",
			"set-cookie": siteCookie(url.hostname, LANGUAGE_COOKIE, choice.language, LANGUAGE_COOKIE_MAX_AGE),
			...headers,
		},
	});
}

/** User agents of crawlers, link previewers and other robots: never sent on by language. */
const ROBOTS =
	/bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|embedly|preview|pinterest|vkshare|whatsapp|telegram|discord|slack|lighthouse|headless|validator|^curl|^wget|python|^java\//i;

/**
 * The browser-language redirect (ADR 0010), when the Site has it on: a visitor's first request to
 * the home page (`/`), with no language chosen yet, goes on (302, never kept) to the home page in the
 * language their browser prefers, which is then remembered. Never for robots (or a request without a
 * user agent), any other path, a visitor with a language cookie, or one already on the Site (a
 * same-origin referrer). Null when the request stays.
 */
export async function browserLanguageRedirect(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	headers: Record<string, string>,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (!host.browserLanguageRedirect || url.pathname !== "/") return null;
	if (cookieValue(request, siteCookieName(url.hostname, LANGUAGE_COOKIE)) !== undefined) return null;
	const agent = request.headers.get("user-agent");
	if (!agent || ROBOTS.test(agent)) return null;
	if (fromSameOrigin(request.headers.get("referer"), url)) return null;
	const home = await services.sitePages.preferredHome(host, request.headers.get("accept-language"));
	if (!home) return null;
	return new Response(null, {
		status: 302,
		headers: {
			location: home.location,
			"cache-control": "no-store",
			vary: LANGUAGE_VARY,
			"set-cookie": siteCookie(url.hostname, LANGUAGE_COOKIE, home.language, LANGUAGE_COOKIE_MAX_AGE),
			...headers,
		},
	});
}

const LANGUAGE_VARY = "Accept-Language, Cookie";

/**
 * While the redirect is on, the home page depends on the browser's language and the language cookie:
 * shared caches must keep it apart by both.
 */
export function languageVary(host: SiteHost, pathname: string): Record<string, string> {
	return host.browserLanguageRedirect && pathname === "/" ? { vary: LANGUAGE_VARY } : {};
}

function fromSameOrigin(referer: string | null, url: URL): boolean {
	if (!referer) return false;
	try {
		return new URL(referer).origin === url.origin;
	} catch {
		return false;
	}
}
