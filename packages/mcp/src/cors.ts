/**
 * Cross-origin access to the MCP server and the OAuth endpoints, for AI clients running in a
 * browser. They carry no cookies (bearer tokens and client credentials only), so any origin may
 * call them; the admin's own procedures never answer another origin.
 */

/** The headers every answer of these endpoints carries for another origin. */
export function corsHeaders(request: Request): Record<string, string> {
	if (!request.headers.has("origin")) return {};
	return {
		"access-control-allow-origin": "*",
		"access-control-expose-headers":
			"www-authenticate, retry-after, ratelimit-limit, ratelimit-remaining, ratelimit-reset, mcp-protocol-version",
	};
}

/** The answer to a CORS preflight (`OPTIONS`): which methods and request headers may follow. */
export function preflight(request: Request, methods: string): Response {
	const asked = request.headers.get("access-control-request-headers");
	return new Response(null, {
		status: 204,
		headers: {
			...corsHeaders(request),
			"access-control-allow-origin": "*",
			"access-control-allow-methods": methods,
			"access-control-allow-headers":
				asked && /^[A-Za-z0-9\-, ]{1,1000}$/.test(asked) ? asked : "authorization, content-type",
			"access-control-max-age": "600",
		},
	});
}
