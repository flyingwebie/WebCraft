import { isDevelopmentHostname, WEBCRAFT_COOKIE_PREFIX } from "@webcraft/core";

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
