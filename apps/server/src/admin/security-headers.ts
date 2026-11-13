import type { Handler } from "../responses.ts";

/**
 * The security headers of every answer on the admin host, set in this one place (`createAdminSide`
 * passes every answer through `withAdminHeaders`).
 *
 * Sites sit on sibling hostnames of the admin (`<slug>.<sites domain>`), which browsers treat as the
 * same site: a page there could frame the admin with the person's session and steal a click, so
 * nothing frames the admin but its own pages (the builder's canvas and the previews, which say so
 * themselves). And nothing injected into an admin page may run: a page's policy takes scripts only
 * from the admin host's own files and from the inline scripts the admin wrote for this one answer
 * (the framework's hydration data, marked with the answer's nonce), never an inline handler or a
 * script from elsewhere. Every other answer (the APIs, built files, downloads, refusals, errors)
 * loads and runs nothing at all, unless it brings a policy of its own.
 */

/** What renders the admin's pages: the request, and the nonce its inline scripts must carry. */
export type AdminApp = (request: Request, page: { nonce: string }) => Promise<Response>;

/** The headers every answer carries unless it brings its own (the canvas frames within the admin). */
const ADMIN_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "same-origin",
};

/** A year, as browsers expect before they keep to HTTPS for a host. */
const TRANSPORT_SECURITY = "max-age=31536000";

/** The policy of an answer that is no page: it loads nothing, runs nothing, and nothing frames it. */
const INERT_POLICY = ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join(
	"; ",
);

/**
 * The policy of an admin page. Scripts: the admin host's files and this answer's own inline scripts
 * (`nonce`); no inline handlers, no `eval`. Styles also inline: the admin's components position
 * themselves with `style` attributes and its toasts add a style sheet. Requests and the Drafts'
 * sockets go to the admin host only (`sockets` names it for browsers whose `'self'` leaves WebSockets
 * out). Frames: the admin's own (the builder's canvas, the previews).
 */
function pagePolicy(nonce: string, sockets: string): string {
	return [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}'`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		`connect-src 'self' ${sockets}`,
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

/** A nonce for one answer's inline scripts: 128 random bits, which nobody can guess or reuse. */
function newNonce(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

/**
 * Gives every answer of the admin side its security headers. `answer` gets the nonce its page's
 * inline scripts must carry. A header an answer set itself is kept (the canvas's own framing rule and
 * policy, a Media preview's policy); `Strict-Transport-Security` goes out only when the admin is on
 * HTTPS (`adminOrigin`: every admin host but a `.localhost` one), where it means something.
 */
export function withAdminHeaders(adminOrigin: string, answer: AdminApp): Handler {
	const origin = new URL(adminOrigin);
	const https = origin.protocol === "https:";
	const sockets = `${https ? "wss" : "ws"}://${origin.host}`;
	return async (request) => {
		const nonce = newNonce();
		const response = await answer(request, { nonce });
		const headers = new Headers(response.headers);
		for (const [name, value] of Object.entries(ADMIN_SECURITY_HEADERS)) {
			if (!headers.has(name)) headers.set(name, value);
		}
		if (https) headers.set("strict-transport-security", TRANSPORT_SECURITY);
		if (!headers.has("content-security-policy")) {
			const page = headers.get("content-type")?.startsWith("text/html") ?? false;
			headers.set("content-security-policy", page ? pagePolicy(nonce, sockets) : INERT_POLICY);
		}
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	};
}
