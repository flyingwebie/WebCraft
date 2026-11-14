import { isAdminReturnPath, isDevelopmentHostname, WEBCRAFT_COOKIE_PREFIX } from "@webcraft/core";

/**
 * Cookies WebCraft sets on a Site's domain. Each is named `webcraft.<what>`, so Modules' Site routes
 * never see it (`isWebCraftCookie`), with the `__Host-` prefix (only this hostname, `Secure`, path `/`)
 * except on a plain-HTTP development hostname under `.localhost`.
 */

/** A WebCraft cookie's name on a hostname: `__Host-webcraft.<what>`, or `webcraft.<what>` in development. */
export function siteCookieName(hostname: string, what: string): string {
	const name = `${WEBCRAFT_COOKIE_PREFIX}.${what}`;
	return isDevelopmentHostname(hostname) ? name : `__Host-${name}`;
}

/** The `Set-Cookie` line for a WebCraft cookie: `HttpOnly`, `Secure` (but in development), `SameSite=Lax`. */
export function siteCookie(hostname: string, what: string, value: string, maxAge: number): string {
	const secure = isDevelopmentHostname(hostname) ? "" : "; Secure";
	return `${siteCookieName(hostname, what)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Lax`;
}

/** One cookie's value from a request's `Cookie` header. */
export function cookieValue(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || undefined;
	}
	return undefined;
}

/**
 * The `Set-Cookie` line for a WebCraft cookie the page's own scripts read (the visitor's consent
 * choice): as `siteCookie`, but not `HttpOnly`.
 */
export function siteScriptCookie(hostname: string, what: string, value: string, maxAge: number): string {
	const secure = isDevelopmentHostname(hostname) ? "" : "; Secure";
	return `${siteCookieName(hostname, what)}=${value}; Path=/; Max-Age=${maxAge}${secure}; SameSite=Lax`;
}

/**
 * The building-area cookie (ADR 0037, while the old editors still run beside it): `webcraft.build`,
 * set as an "Edit on site" link that opens the building area is followed, for the rest of the Edit mode
 * session. While it is set, pages rendered for editing carry the page agent instead of the editing bar
 * and may be framed by their own origin, and a page opened at the top level goes into the shell. Its
 * value is the admin path the logo tile goes back to, percent-encoded.
 */
export const BUILDING_AREA_COOKIE = "build";

/** The admin path a building-area cookie holds, or null when the request carries none (or a broken one). */
export function buildingAreaCookieOf(request: Request): string | null {
	const value = cookieValue(request, siteCookieName(new URL(request.url).hostname, BUILDING_AREA_COOKIE));
	if (value === undefined) return null;
	try {
		const path = decodeURIComponent(value);
		return isAdminReturnPath(path) ? path : null;
	} catch {
		return null;
	}
}
