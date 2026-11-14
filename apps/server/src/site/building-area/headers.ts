/**
 * The building area's shell document (ADR 0037) gets a policy of its own: WebCraft's own hashed files
 * from the Site's domain and nothing inline, the page framed from the same origin, requests (and the
 * co-editing sockets) to the Site's own address only, and framed by nobody.
 */
export function shellPolicy(url: URL): string {
	// `'self'` covers WebSockets to the same host in current browsers; the origin is named as well for
	// those that read it strictly.
	const sockets = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
	return [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"font-src 'self'",
		"img-src 'self' data: https:",
		`connect-src 'self' ${sockets}`,
		"frame-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"object-src 'none'",
		"form-action 'self'",
	].join("; ");
}

/** Every answer of the shell's own paths: never kept, never indexed, never framed. */
export function shellHeaders(url: URL): Record<string, string> {
	return {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"x-robots-tag": "noindex, nofollow",
		"referrer-policy": "same-origin",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
		"content-security-policy": shellPolicy(url),
	};
}
