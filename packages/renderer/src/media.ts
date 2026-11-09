/**
 * Media images (ADR 0027): an `<img>` whose `src` reads `media:<id>`, written as fixed text in a
 * Template or read from a media Field, renders as `<picture>` with an AVIF and a WebP `<source>`
 * (every width the worker made, with `sizes`), and the original as the `<img>` fallback, with its
 * `width`, `height` and alt text. The first Media image in `<main>` loads eagerly with high priority,
 * every other one lazily. In any other URL attribute (`href`, a video's `src`), `media:<id>` becomes
 * the file's own address.
 */
import { escapeAttribute } from "./escape.ts";

/** A Media item as a page shows it: what core read for the page, in the page's language. */
export type PageMedia = {
	kind: "image" | "document" | "video" | "audio";
	/** The original, on the Site's own domain: `/_media/<hash>-<name>`. */
	url: string;
	width: number | null;
	height: number | null;
	/** The Media library's alt text in the page's language, or null when it has none. */
	alt: string | null;
	/** The Media library's caption in the page's language (a Body's image shows it), or null when it has none. */
	caption?: string | null;
	/** The variants by format, AVIF first; empty until the worker made them. */
	sources: { type: string; candidates: { url: string; width: number }[] }[];
};

/** Finds a Media item of the page's Site by id; undefined for one it doesn't have (or isn't ready). */
export type MediaReader = (id: string) => PageMedia | undefined;

/** Whether the page's first Media image in `<main>` has been written yet. */
export type ImagePriority = { given: boolean };

const MEDIA_REFERENCE = /^\s*media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;

/** The Media id a URL value refers to (`media:<id>`), or undefined. */
export function mediaReference(value: string): string | undefined {
	return MEDIA_REFERENCE.exec(value)?.[1]?.toLowerCase();
}

/** Every Media id a piece of text refers to, such as the text of a Template's attributes. */
export function mediaReferencesIn(text: string): string[] {
	return [...text.matchAll(/media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map((match) =>
		(match[1] ?? "").toLowerCase(),
	);
}

/** Attributes WebCraft writes itself on a Media image; the Template's own win where it gives them. */
const WRITTEN = new Set(["src", "srcset", "sizes", "alt", "width", "height", "loading", "fetchpriority"]);

/**
 * Writes a Media image. `own` holds the `<img>` element's own attributes with their values read (its
 * `class` first); `priority` is the page's first-image marker in `<main>`, if any.
 */
export function renderMediaImage(image: PageMedia, own: readonly [string, string][], priority?: ImagePriority): string {
	const given = new Map(own);
	const naturalWidth = image.width;
	const naturalHeight = image.height;
	let width = naturalWidth;
	let height = naturalHeight;
	const givenWidth = positive(given.get("width"));
	const givenHeight = positive(given.get("height"));
	if (givenWidth && givenHeight) {
		width = givenWidth;
		height = givenHeight;
	} else if (givenWidth && naturalWidth && naturalHeight) {
		width = givenWidth;
		height = Math.round((naturalHeight * givenWidth) / naturalWidth);
	} else if (givenHeight && naturalWidth && naturalHeight) {
		height = givenHeight;
		width = Math.round((naturalWidth * givenHeight) / naturalHeight);
	}
	const first = priority !== undefined && !priority.given;
	if (priority) priority.given = true;

	const attributes: [string, string][] = [];
	const className = given.get("class");
	if (className !== undefined) attributes.push(["class", className]);
	attributes.push(["src", image.url], ["alt", given.get("alt") ?? image.alt ?? ""]);
	if (width && height) attributes.push(["width", String(width)], ["height", String(height)]);
	const loading = given.get("loading") ?? (first ? "eager" : "lazy");
	attributes.push(["loading", loading]);
	// A Template that makes its first image lazy on purpose doesn't get it fetched first either.
	const fetchPriority = given.get("fetchpriority") ?? (first && loading !== "lazy" ? "high" : undefined);
	if (fetchPriority !== undefined) attributes.push(["fetchpriority", fetchPriority]);
	for (const [name, value] of own) {
		if (name !== "class" && !WRITTEN.has(name)) attributes.push([name, value]);
	}
	const img = `<img${attributes.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("")}>`;

	const sources = image.sources.filter((source) => source.candidates.length > 0);
	if (sources.length === 0) return img;
	const sizes = given.get("sizes") ?? (width ? `(min-width: ${width}px) ${width}px, 100vw` : "100vw");
	const sourceTags = sources.map((source) => {
		const srcset = [...source.candidates]
			.sort((a, b) => a.width - b.width)
			.map((candidate) => `${candidate.url} ${candidate.width}w`)
			.join(", ");
		return `<source type="${escapeAttribute(source.type)}" srcset="${escapeAttribute(srcset)}" sizes="${escapeAttribute(sizes)}">`;
	});
	return `<picture>${sourceTags.join("")}${img}</picture>`;
}

function positive(value: string | undefined): number | undefined {
	if (value === undefined || !/^\s*\d+\s*$/.test(value)) return undefined;
	const number = Number(value);
	return number > 0 ? number : undefined;
}
