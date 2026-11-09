/**
 * What a page tells search engines and other sites about itself, in its `<head>` (the SEO decision):
 * its title, description and canonical URL, robots noindex, Open Graph and social tags, and
 * structured data as JSON-LD. Core works the values out (SEO fields and their fallbacks, the Site's
 * addresses, the Schema type); the renderer only writes them, each escaped for where it lands.
 *
 * JSON-LD is a `<script type="application/ld+json">` data block: browsers never run it, so the
 * Site's strict policy has nothing to allow (ADR 0023). Its text is JSON with `<`, `>`, `&` and the
 * line and paragraph separators written as escapes, so nothing in a value can end the block or be read
 * as markup, and every value in it is plain text.
 */
import { escapeAttribute } from "./escape.ts";

/** A JSON value of structured data. */
export type JsonLd = string | number | boolean | null | readonly JsonLd[] | { readonly [key: string]: JsonLd };

/** An image other sites show for the page: an absolute address, its type and size, and its alt text. */
export type SocialImage = {
	url: string;
	type: string | null;
	width: number | null;
	height: number | null;
	alt: string | null;
};

/** The Open Graph and social tags of a page. */
export type PageSharing = {
	/** `article` for an Article or Blog post, `website` for everything else. */
	type: "website" | "article";
	/** The page's own title, without the Site's name (which `siteName` says). */
	title: string;
	description: string | null;
	/** The page's canonical URL; null when it has none (the 404 page). */
	url: string | null;
	siteName: string;
	/** The page's language as Open Graph writes it (`en`, `pt_BR`), and the other languages it is in. */
	locale: string;
	alternateLocales: readonly string[];
	image: SocialImage | null;
	/** For an article: when it was first and last published, as ISO 8601. */
	publishedTime?: string | null;
	modifiedTime?: string | null;
};

/** What a page tells search engines and other sites about itself. */
export type PageSeo = {
	/** The document's whole title, as `<title>` says it. */
	title: string;
	description: string | null;
	canonical: string | null;
	/** Whether search engines are asked not to index the page. */
	noindex: boolean;
	sharing: PageSharing | null;
	/** The nodes of the page's structured data, written as one JSON-LD graph. */
	structuredData: readonly { readonly [key: string]: JsonLd }[];
};

/**
 * The tags `<head>` holds for a page's SEO, in order: its description, robots (never in Edit mode,
 * whose own `noindex, nofollow` comes first), canonical URL, then what `sharingTags` writes after the
 * `hreflang` alternates.
 */
export function seoTags(seo: PageSeo, options: { editMode: boolean }): string[] {
	return [
		...(seo.description ? [meta("name", "description", seo.description)] : []),
		...(seo.noindex && !options.editMode ? [meta("name", "robots", "noindex")] : []),
		...(seo.canonical ? [`<link rel="canonical" href="${escapeAttribute(seo.canonical)}">`] : []),
	];
}

/** The Open Graph and social tags, then the structured data, as `<head>` holds them after the alternates. */
export function sharingTags(seo: PageSeo): string[] {
	const tags: string[] = [];
	const sharing = seo.sharing;
	if (sharing) {
		tags.push(meta("property", "og:type", sharing.type), meta("property", "og:title", sharing.title));
		if (sharing.description) tags.push(meta("property", "og:description", sharing.description));
		if (sharing.url) tags.push(meta("property", "og:url", sharing.url));
		tags.push(meta("property", "og:site_name", sharing.siteName), meta("property", "og:locale", sharing.locale));
		for (const locale of sharing.alternateLocales) tags.push(meta("property", "og:locale:alternate", locale));
		const image = sharing.image;
		if (image) {
			tags.push(meta("property", "og:image", image.url));
			if (image.type) tags.push(meta("property", "og:image:type", image.type));
			if (image.width) tags.push(meta("property", "og:image:width", String(image.width)));
			if (image.height) tags.push(meta("property", "og:image:height", String(image.height)));
			if (image.alt) tags.push(meta("property", "og:image:alt", image.alt));
		}
		if (sharing.type === "article") {
			if (sharing.publishedTime) tags.push(meta("property", "article:published_time", sharing.publishedTime));
			if (sharing.modifiedTime) tags.push(meta("property", "article:modified_time", sharing.modifiedTime));
		}
		tags.push(meta("name", "twitter:card", image ? "summary_large_image" : "summary"));
		tags.push(meta("name", "twitter:title", sharing.title));
		if (sharing.description) tags.push(meta("name", "twitter:description", sharing.description));
		if (image) {
			tags.push(meta("name", "twitter:image", image.url));
			if (image.alt) tags.push(meta("name", "twitter:image:alt", image.alt));
		}
	}
	if (seo.structuredData.length > 0) {
		const graph = { "@context": "https://schema.org", "@graph": seo.structuredData };
		tags.push(`<script type="application/ld+json">${jsonLdText(graph)}</script>`);
	}
	return tags;
}

function meta(attribute: "name" | "property", key: string, content: string): string {
	return `<meta ${attribute}="${key}" content="${escapeAttribute(content)}">`;
}

/**
 * Structured data as the text of a JSON-LD block: JSON with every `<`, `>` and `&` and the line and
 * paragraph separators (U+2028, U+2029) written as `\u` escapes. JSON reads them back the same, and
 * no value can close the `<script>` element, open a comment or be read as anything but text.
 */
export function jsonLdText(value: JsonLd): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replaceAll(" ", "\\u2028")
		.replaceAll(" ", "\\u2029");
}

/**
 * Text cut to at most `max` characters at the end of a word, with `…` after it (it fits within `max`
 * plus one): how a description made from a Field or a body is cut. Text that fits is left whole.
 */
export function cutText(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	const characters = [...clean];
	if (characters.length <= max) return clean;
	const head = characters.slice(0, max + 1).join("");
	const atWord = head.slice(0, Math.max(head.lastIndexOf(" "), 0)).replace(/[\s,;:–—-]+$/u, "");
	const cut = atWord.length >= max / 2 ? atWord : characters.slice(0, max).join("");
	return `${cut}…`;
}
