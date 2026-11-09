/**
 * Reading what a page tells search engines and other sites in its `<head>` (SEO fields, Open Graph
 * and social tags, JSON-LD), the way a crawler reads it: from the HTML a visitor gets.
 */

/** The page's `<head>`, as written. */
export function headOf(html: string): string {
	return /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
}

/** The page's `<title>`, its character references read. */
export function titleIn(html: string): string | undefined {
	const title = /<title>([\s\S]*?)<\/title>/.exec(headOf(html))?.[1];
	return title === undefined ? undefined : decode(title);
}

/** The content of `<meta name="…">`, read; undefined without one. */
export function metaName(html: string, name: string): string | undefined {
	return attributeOf(html, new RegExp(`<meta name="${escapeRegExp(name)}" content="([^"]*)">`));
}

/** The contents of every `<meta property="…">` with that property, in order. */
export function metaProperties(html: string, property: string): string[] {
	return [
		...headOf(html).matchAll(new RegExp(`<meta property="${escapeRegExp(property)}" content="([^"]*)">`, "g")),
	].map((match) => decode(match[1] ?? ""));
}

/** The content of the first `<meta property="…">`, read; undefined without one. */
export function metaProperty(html: string, property: string): string | undefined {
	return metaProperties(html, property)[0];
}

/** The page's canonical URL (`<link rel="canonical">`); undefined without one. */
export function canonicalIn(html: string): string | undefined {
	return attributeOf(html, /<link rel="canonical" href="([^"]*)">/);
}

/** Every JSON-LD block of the page, parsed. */
export function jsonLdIn(html: string): unknown[] {
	return [...headOf(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) =>
		JSON.parse(match[1] ?? "null"),
	);
}

/** The nodes of the page's JSON-LD graph, each with its `@type`. */
export function jsonLdNodes(html: string): Record<string, unknown>[] {
	return jsonLdIn(html).flatMap((block) => {
		const graph = (block as { "@graph"?: unknown[] })["@graph"];
		return (Array.isArray(graph) ? graph : [block]) as Record<string, unknown>[];
	});
}

/** The JSON-LD node of a type (`WebSite`, `BreadcrumbList`, `Article`); undefined without one. */
export function jsonLdNode(html: string, type: string): Record<string, unknown> | undefined {
	return jsonLdNodes(html).find((node) => node["@type"] === type);
}

function attributeOf(html: string, pattern: RegExp): string | undefined {
	const value = pattern.exec(headOf(html))?.[1];
	return value === undefined ? undefined : decode(value);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text with the character references WebCraft writes read back. */
export function decode(text: string): string {
	return text
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

/**
 * A page without its structured data: every page carries one JSON-LD block (data, never run), so a
 * check that a page holds no `<script>` element at all looks at the rest.
 */
export function withoutStructuredData(html: string): string {
	return html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/g, "");
}

/** The page's structured data line, as written (its content is checked by the SEO tests). */
export function structuredDataLine(html: string): string {
	return /<script type="application\/ld\+json">[\s\S]*?<\/script>/.exec(html)?.[0] ?? "";
}
