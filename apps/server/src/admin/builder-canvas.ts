/**
 * The visual builder's canvas (#66): an empty page on the admin host that the builder loads in an
 * iframe and fills itself, with a tree rendered as the Site renders it and the Site's Draft
 * stylesheet (a constructed stylesheet, which no policy blocks). It never runs a script: the builder
 * frames it sandboxed without scripts, and its own policy allows none either, so the Site's scripts
 * and anything in a Template that could run never do. Only the admin's own pages may frame it.
 */

/** Where the canvas is on the admin host. */
export const BUILDER_CANVAS_PATH = "/api/builder/canvas";

const CANVAS_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Canvas</title></head><body></body></html>';

/**
 * No script and no default: images and video as Site pages show them (Templates may show outside
 * images, Media from the admin host), fonts from the admin host or outside, styles only from files
 * on it (the builder's constructed stylesheet isn't one a policy governs), nothing posted or framed.
 */
const CANVAS_POLICY = [
	"default-src 'none'",
	"img-src 'self' data: https:",
	"media-src 'self' https:",
	"font-src 'self' data: https:",
	"style-src 'self'",
	"frame-ancestors 'self'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");

export function builderCanvas(): Response {
	return new Response(CANVAS_HTML, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-cache",
			"content-security-policy": CANVAS_POLICY,
			"x-content-type-options": "nosniff",
			"x-frame-options": "SAMEORIGIN",
			"referrer-policy": "no-referrer",
		},
	});
}
