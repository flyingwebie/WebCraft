/**
 * A Site's Content Security Policy and the fixed security headers (ADR 0023). Pages are cached, so
 * there are no per-request nonces: WebCraft never writes inline scripts, and the policy allows scripts
 * only from the Site's own domain and its allowed hosts. Each Site picks how it applies:
 *
 * - **Strict** (the default): the policy is enforced.
 * - **Relaxed**: inline scripts and `eval` are allowed too, for tag managers that inject them.
 * - **Report only**: the strict policy is only reported; the fixed directives are still enforced.
 *
 * Whatever the mode, every answer on a Site's domain blocks plugins, base-tag changes, framing by
 * other sites and forms posting elsewhere, never sniffs types and sends a strict referrer policy.
 */

/** How a Site's Content Security Policy applies. */
export const CSP_MODES = ["strict", "relaxed", "reportOnly"] as const;

export type CspMode = (typeof CSP_MODES)[number];

export function isCspMode(value: string): value is CspMode {
	return (CSP_MODES as readonly string[]).includes(value);
}

/** A host that can't be put in a policy: not a host name, or one no outside script could be on. */
export class HostInvalidError extends Error {
	override name = "HostInvalidError";
	readonly host: string;
	constructor(host: string) {
		super(
			`${host.slice(0, 100)} isn't a host name: give one such as tags.example.com, or *.example.com for every host under it.`,
		);
		this.host = host;
	}
}

/** One label of a host name: letters, digits and dashes, not starting or ending with a dash. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** The last label: letters (or an internationalised `xn--` one), never a number. */
const TOP_LEVEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A host as a policy holds it: a host name in lower case (`tags.example.com`), or `*.` and a domain
 * of at least two labels for every host under it (`*.example.com`). Anything else, a scheme, a path, a
 * port, an address, a quoted keyword or a `;`, is refused (`HostInvalidError`), so nothing but a host
 * ever reaches the policy.
 */
export function readHost(input: string): string {
	const host = input.trim().toLowerCase().replace(/\.$/, "");
	const wildcard = host.startsWith("*.");
	const labels = (wildcard ? host.slice(2) : host).split(".");
	const valid =
		host.length <= 253 &&
		labels.length >= 2 &&
		labels.every((label) => LABEL.test(label)) &&
		TOP_LEVEL.test(labels.at(-1) ?? "");
	if (!valid) throw new HostInvalidError(input);
	return host;
}

/** A host as a source in a policy: over https only. */
function sourceOf(host: string): string {
	return `https://${host}`;
}

/** The directives every answer on a Site's domain enforces, whatever its mode. */
export const FIXED_DIRECTIVES = [
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'self'",
];

/** The headers every answer on a Site's domain carries (an answer may set stricter ones of its own). */
export const SITE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
	"x-frame-options": "SAMEORIGIN",
};

/** The policy of a Site's answers that aren't pages (stylesheets, scripts, redirects, plain answers). */
export const FILE_POLICY = FIXED_DIRECTIVES.join("; ");

/**
 * The policy of a Site's Media files. A browser may open one by itself (a PDF in its own viewer),
 * which `object-src 'none'` would stop, so they get the rest of the fixed directives.
 */
export const MEDIA_POLICY = FIXED_DIRECTIVES.filter((directive) => !directive.startsWith("object-src")).join("; ");

/**
 * The policy of an SVG Media file, which a browser opened by itself treats as a document: it runs
 * nothing (`script-src 'none'`, `sandbox`) and loads nothing from elsewhere, whatever the cleaning
 * missed. Its own styles and inline raster images still show.
 */
export const SVG_POLICY = [
	"default-src 'none'",
	"script-src 'none'",
	"style-src 'unsafe-inline'",
	"img-src data:",
	"font-src data:",
	"sandbox",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'self'",
].join("; ");

/** The policy a Media file is served with, by its type. */
export function mediaPolicy(contentType: string): string {
	return contentType === "image/svg+xml" ? SVG_POLICY : MEDIA_POLICY;
}

/** What a page's policy is worked out from. */
export type PagePolicyInput = {
	mode: CspMode;
	/** The Site's allowed hosts and those of the Modules running on it, as `readHost` gives them. */
	hosts: readonly string[];
	/** Origins the page frames (a body's video players), such as `https://player.vimeo.com`. */
	frames?: readonly string[];
};

/**
 * The policy headers of a page of a Site, by its mode: the full policy enforced (Strict, Relaxed), or
 * reported with only the fixed directives enforced (Report only). Scripts, styles, fonts, requests and
 * frames come from the Site and its allowed hosts; images and media from https too, since Templates
 * may show outside images; forms post only to the Site.
 */
export function pagePolicyHeaders(input: PagePolicyInput): Record<string, string> {
	const hosts = [...new Set(input.hosts)].sort().map(sourceOf);
	const relaxed = input.mode === "relaxed";
	const policy = [
		"default-src 'self'",
		["script-src 'self'", ...(relaxed ? ["'unsafe-inline'", "'unsafe-eval'"] : []), ...hosts].join(" "),
		["style-src 'self'", ...(relaxed ? ["'unsafe-inline'"] : []), ...hosts].join(" "),
		"img-src 'self' data: https:",
		"media-src 'self' https:",
		["font-src 'self'", ...hosts].join(" "),
		["connect-src 'self'", ...hosts].join(" "),
		["frame-src 'self'", ...(input.frames ?? []), ...hosts].join(" "),
		...FIXED_DIRECTIVES,
	].join("; ");
	if (input.mode === "reportOnly") {
		return { "content-security-policy": FILE_POLICY, "content-security-policy-report-only": policy };
	}
	return { "content-security-policy": policy };
}

/**
 * The policy of pages in Edit mode (ADRs 0022, 0023), whatever the Site's mode: scripts, styles and
 * fonts only from the Site's own domain, so no outside script runs with the person's edit session.
 * Requests may also go to the Site's allowed hosts, which only the Site's own scripts can reach here.
 * Iframe embeds still show; the page can't be framed at all, post forms elsewhere or change its base.
 */
export function editModePolicy(hosts: readonly string[] = []): string {
	return [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' data: https:",
		"media-src 'self' https:",
		"font-src 'self'",
		["connect-src 'self'", ...[...new Set(hosts)].sort().map(sourceOf)].join(" "),
		"frame-src https:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

/** How many allowed hosts a Site holds at most, those Staff add and those its outside scripts need. */
export const ALLOWED_HOSTS_PER_SITE = 100;
