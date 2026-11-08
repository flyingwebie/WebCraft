/** Escapes text for an HTML text position. */
export function escapeText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escapes text for a double-quoted attribute value. */
export function escapeAttribute(text: string): string {
	return escapeText(text).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Attributes holding one URL, checked with `safeUrl`. */
export const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
	"href",
	"src",
	"cite",
	"poster",
	"action",
	"background",
	"longdesc",
	"itemid",
]);

/** Attributes holding a list of image candidates, `url [descriptor]`, separated by commas. */
export const SRCSET_ATTRIBUTES: ReadonlySet<string> = new Set(["srcset", "imagesrcset"]);

/** Attributes holding URLs separated by spaces. */
export const URL_LIST_ATTRIBUTES: ReadonlySet<string> = new Set(["ping"]);

const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

/** The scheme a URL starts with, read the way browsers read it, or undefined for a relative URL. */
export function schemeOf(url: string): string | undefined {
	// Browsers drop tabs and newlines anywhere, and leading C0 controls and spaces.
	const read = url.replace(/[\t\n\r]/g, "");
	let start = 0;
	while (start < read.length && read.charCodeAt(start) <= 0x20) start++;
	return /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(read.slice(start))?.[1]?.toLowerCase();
}

/**
 * A URL as it may appear in a page: relative paths, `#anchors`, and `http`, `https`, `mailto` and
 * `tel` addresses pass; anything else (`javascript:`, `data:`, …) becomes `#`. The scheme is read
 * the way browsers read it, ignoring the whitespace and control characters they ignore.
 */
export function safeUrl(url: string): string {
	const scheme = schemeOf(url);
	if (scheme === undefined) return url;
	return SAFE_SCHEMES.has(scheme) ? url : "#";
}

/** Each candidate of a `srcset` with its URL checked by `safeUrl`. */
export function safeSrcset(srcset: string): string {
	return srcset
		.split(",")
		.map((candidate) => {
			const [url = "", ...descriptor] = candidate.trim().split(/\s+/);
			return [safeUrl(url), ...descriptor].join(" ");
		})
		.join(", ");
}

/** Each URL of a space-separated list checked by `safeUrl`. */
export function safeUrlList(urls: string): string {
	return urls
		.split(/\s+/)
		.filter(Boolean)
		.map((url) => safeUrl(url))
		.join(" ");
}

/** An attribute's value made safe for where it lands: URLs checked, anything else as it is. */
export function safeAttributeValue(name: string, value: string): string {
	if (URL_ATTRIBUTES.has(name)) return safeUrl(value);
	if (SRCSET_ATTRIBUTES.has(name)) return safeSrcset(value);
	if (URL_LIST_ATTRIBUTES.has(name)) return safeUrlList(value);
	return value;
}
