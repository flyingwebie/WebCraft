import { type InstallServices, LANGUAGE_CHOICE_PATH, type SiteHost } from "@webcraft/core";

import { plainText } from "../responses.ts";
import { siteCookie } from "./cookies.ts";

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
