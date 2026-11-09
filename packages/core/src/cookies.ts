/**
 * The start of every cookie name WebCraft uses: the admin's session cookies (`webcraft.session_token`,
 * see `@webcraft/auth`) and every cookie it sets on a Site's domain, such as Edit mode's. Name each
 * new one `webcraft.<what>`: Modules' Site routes never see a cookie named so, nor set one.
 */
export const WEBCRAFT_COOKIE_PREFIX = "webcraft";

/** Whether a cookie is one of WebCraft's own, with or without the `__Secure-` or `__Host-` prefix. */
export function isWebCraftCookie(name: string): boolean {
	const plain = name.trim().replace(/^__(?:Secure|Host)-/i, "");
	return plain.toLowerCase().startsWith(`${WEBCRAFT_COOKIE_PREFIX}.`);
}

/** A `Cookie` header without WebCraft's own cookies, or null when nothing else is left. */
export function withoutWebCraftCookies(header: string | null): string | null {
	if (header === null) return null;
	const kept = header
		.split(";")
		.map((pair) => pair.trim())
		.filter((pair) => pair !== "" && !isWebCraftCookie(pair.split("=")[0] ?? ""));
	return kept.length > 0 ? kept.join("; ") : null;
}
