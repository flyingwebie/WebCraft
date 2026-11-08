/** The URL schemes a page may link to; anything else becomes `#`. */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

/**
 * A URL as it may appear in a page: relative paths, `#anchors`, and `http`, `https`, `mailto` and
 * `tel` addresses pass; anything else (`javascript:`, `data:`, …) becomes `#`. The scheme is read
 * the way browsers read it, ignoring the whitespace and control characters they ignore.
 */
export function safeUrl(url: string): string {
	// Browsers drop tabs and newlines anywhere, and leading C0 controls and spaces.
	const read = url.replace(/[\t\n\r]/g, "");
	let start = 0;
	while (start < read.length && read.charCodeAt(start) <= 0x20) start++;
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(read.slice(start))?.[1];
	if (scheme === undefined) return url;
	return SAFE_SCHEMES.has(scheme.toLowerCase()) ? url : "#";
}
