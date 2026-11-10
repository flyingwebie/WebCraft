import {
	type Block,
	bodyMarkdown,
	escapeMarkdownLine,
	markdownLink,
	markdownUrl,
	richTextToText,
	storedBlocks,
} from "@webcraft/renderer";

import { entryValues } from "../content/entries.ts";
import type { FieldDefinition, Json } from "../content/field-types.ts";
import type { Languages } from "../content/field-values.ts";
import { prefixOf } from "../content/languages.ts";
import type { PostType } from "../content/post-types.ts";
import { storedVersion } from "../content/values.ts";
import { placeOf } from "../domains/addresses.ts";
import { pageMedia } from "../media/page-media.ts";
import { readEntrySeo } from "../seo/entry-seo.ts";
import { canonicalOf } from "../seo/page-seo.ts";
import { publishedEntryAt } from "../site-pages/index.ts";
import { relatedEntries } from "../site-pages/related.ts";
import type { Listing } from "./listed.ts";
import { markdownCopyAddress, summaryOf } from "./llms.ts";

/**
 * Markdown copies (spec story 118): every indexable Entry's page has a copy in Markdown at its
 * address plus `.md` (`/blog/fresh-bread.md`, `/fr/blog/pain-frais.md`); the home page, whose address
 * ends in `/`, at `/index.html.md` (`/fr.md` for a language's home under its prefix), as the llms.txt
 * proposal writes it. It holds the Entry's title, its Summary (else its SEO description), the Fields a
 * reader needs (`fieldsMarkdown`) and its Body field, Block by Block (`bodyMarkdown`), in the page's
 * language, every text escaped, every address absolute, no HTML. It is sent with a `Link` header
 * naming the page's canonical URL, as the page's head does.
 *
 * A page with no copy (404): a noindex Entry, one hidden in the language (it has no page there), the
 * Site's 404 pages and its search results page, a path a Redirect rule sends elsewhere, an Archive
 * page (a list, not an Entry). A copy whose page lives on another of the Site's domains goes there.
 */

/** A page's Markdown copy, or where it is now. */
export type MarkdownAnswer = { text: string; canonical: string } | { location: string } | null;

/** The suffix of a Markdown copy's address. */
export const MARKDOWN_SUFFIX = ".md";

/** The copy of the page at the root of a language (an address ending in `/`). */
const ROOT_COPY = "/index.html.md";

/** The page a Markdown copy's path is of (`/blog/x.md` → `/blog/x`, `/index.html.md` → `/`); null for no copy's path. */
export function pageOfCopy(pathname: string): string | null {
	if (pathname === ROOT_COPY) return "/";
	if (!pathname.endsWith(MARKDOWN_SUFFIX)) return null;
	const page = pathname.slice(0, -MARKDOWN_SUFFIX.length);
	return page === "" || page.endsWith("/") ? null : page;
}

/** The Markdown copy of the page at a copy's path on the domain. */
export async function markdownCopy(list: Listing, pathname: string): Promise<MarkdownAnswer> {
	const page = pageOfCopy(pathname);
	if (page === null) return null;
	const found = await publishedEntryAt(list.scope, list.host, page);
	if (!found) return null;
	if (found.kind === "redirect") {
		return { location: markdownCopyAddress(new URL(found.location, list.host.origin).href) };
	}
	const { entry, postType, languages } = found;
	if (list.unlisted.has(entry.id)) return null;
	const version = storedVersion(entry.published);
	const values = entryValues(version, postType.fields, languages);
	const seo = readEntrySeo(version.values, languages);
	if (seo.noindex) return null;
	const sitePath = await sitePathOf(list, page);
	const there = placeOf(list.host.addresses, languages, sitePath);
	const address = `${there.origin}${there.path}`;
	if ((await list.redirected([{ sitePath, language: languages.language, loc: address }])).has(sitePath)) return null;
	const canonical = seo.canonical
		? canonicalOf({ addresses: list.host.addresses, languages: list.site }, seo.canonical)
		: address;
	const resolve = await resolver(list, found.postTypes, postType, values.fields, languages, address);
	const lines = [`# ${escapeMarkdownLine(values.title)}`];
	const lead = summaryOf(postType, version, languages) ?? seo.description;
	if (lead) lines.push("", `> ${escapeMarkdownLine(lead)}`);
	const fields = fieldsMarkdown(shownFields(postType), values.fields, resolve, "");
	if (fields) lines.push("", fields);
	const body = postType.fields.find((field) => field.type === "body");
	const blocks = body ? storedBlocks(values.fields[body.key]) : [];
	const text = bodyMarkdown(blocks, { link: resolve.link, image: resolve.image });
	if (text) lines.push("", text);
	return { text: `${lines.join("\n")}\n`, canonical };
}

/** A page's path as the Site writes it (under its language's prefix), from its path on this domain. */
async function sitePathOf(list: Listing, page: string): Promise<string> {
	const { host, site } = list;
	if (host.address !== "language" || !host.language || host.language === site.defaultLanguage) return page;
	const prefix = `/${prefixOf(host.language)}`;
	return page === "/" ? prefix : `${prefix}${page}`;
}

/** The Fields a reader needs: every Field but the Summary (shown first), the Body (shown last) and switches. */
function shownFields(postType: PostType): FieldDefinition[] {
	return postType.fields.filter(
		(field) => field.key !== postType.summaryField && field.type !== "body" && field.type !== "boolean",
	);
}

/** How a copy reads values that point elsewhere: links, Media files and related Entries, all absolute. */
type Resolve = {
	link(url: string): string;
	image(mediaId: string): { url: string; alt: string | null; caption: string | null } | undefined;
	media(mediaId: string): { url: string; alt: string | null; image: boolean } | undefined;
	entry(entryId: string): { title: string; url: string | null } | undefined;
};

/** Reads, at once, the Media files and related Entries an Entry's values and body point at. */
async function resolver(
	list: Listing,
	postTypes: readonly PostType[],
	postType: PostType,
	values: Record<string, Json>,
	languages: Languages,
	address: string,
): Promise<Resolve> {
	const origin = new URL(address).origin;
	const mediaIds: string[] = [];
	const entryIds: string[] = [];
	collect(postType.fields, values, mediaIds, entryIds);
	const files = await pageMedia(list.scope, mediaIds, languages);
	const related = await relatedEntries(list.scope, postTypes, entryIds, languages);
	const absolute = (url: string) => (url.startsWith("/") ? `${origin}${url}` : url);
	return {
		link: (url) => (url.startsWith("#") ? `${address}${url}` : absolute(url)),
		image(mediaId) {
			const file = files.get(mediaId.toLowerCase());
			if (file?.kind !== "image") return undefined;
			return { url: absolute(file.url), alt: file.alt, caption: file.caption ?? null };
		},
		media(mediaId) {
			const file = files.get(mediaId.toLowerCase());
			return file ? { url: absolute(file.url), alt: file.alt, image: file.kind === "image" } : undefined;
		},
		entry(entryId) {
			const found = related.get(entryId);
			if (!found) return undefined;
			const path = found.builtIns.url;
			const there = typeof path === "string" ? placeOf(list.host.addresses, languages, path) : null;
			return { title: String(found.builtIns.title ?? ""), url: there ? `${there.origin}${there.path}` : null };
		},
	};
}

/** The Media and Entries values point at: media Fields, a body's images, Relationships. */
function collect(fields: readonly FieldDefinition[], values: Record<string, Json>, media: string[], linked: string[]) {
	for (const field of fields) {
		const value = values[field.key];
		if (value === null || value === undefined) continue;
		if (field.type === "media" && typeof value === "string") media.push(value);
		if (field.type === "body") {
			for (const block of storedBlocks(value) as Block[])
				if (block.type === "image" && block.media) media.push(block.media);
		}
		if (field.type === "relationship") linked.push(...(Array.isArray(value) ? value : [value]).filter(isText));
		if (field.type === "group" && isRecord(value)) collect(field.fields, value, media, linked);
		if (field.type === "repeater" && Array.isArray(value)) {
			for (const row of value) if (isRecord(row)) collect(field.fields, row, media, linked);
		}
	}
}

/**
 * The Fields a reader needs, as a list: `- **Label:** value` for each Field with a value; a Group's
 * Fields nested under it; a Repeater's rows numbered, each its Fields' values on one line.
 */
function fieldsMarkdown(
	fields: readonly FieldDefinition[],
	values: Record<string, Json>,
	resolve: Resolve,
	indent: string,
): string {
	const lines: string[] = [];
	for (const field of fields) {
		const value = values[field.key];
		const label = `**${escapeMarkdownLine(field.label || field.key)}:**`;
		if (field.type === "group") {
			const inner = isRecord(value) ? fieldsMarkdown(field.fields, value, resolve, `${indent}  `) : "";
			if (inner) lines.push(`${indent}- ${label}`, inner);
			continue;
		}
		if (field.type === "repeater") {
			const rows = (Array.isArray(value) ? value : [])
				.filter(isRecord)
				.map((row) => rowText(field.fields, row, resolve))
				.filter((row) => row !== "");
			if (rows.length > 0)
				lines.push(`${indent}- ${label}`, ...rows.map((row, index) => `${indent}  ${index + 1}. ${row}`));
			continue;
		}
		const text = leafText(field, value, resolve);
		if (text) lines.push(`${indent}- ${label} ${text}`);
	}
	return lines.join("\n");
}

/** A Repeater row on one line: each Field with a value as `**Label:** value`, `;` between them. */
function rowText(fields: readonly FieldDefinition[], row: Record<string, Json>, resolve: Resolve): string {
	const parts: string[] = [];
	for (const field of fields) {
		if (field.type === "body" || field.type === "boolean") continue;
		const value = row[field.key];
		const text =
			field.type === "group"
				? isRecord(value)
					? rowText(field.fields, value, resolve)
					: ""
				: field.type === "repeater"
					? (Array.isArray(value) ? value : [])
							.filter(isRecord)
							.map((inner) => rowText(field.fields, inner, resolve))
							.filter((inner) => inner !== "")
							.join(", ")
					: leafText(field, value, resolve);
		if (text) parts.push(`**${escapeMarkdownLine(field.label || field.key)}:** ${text}`);
	}
	return parts.join("; ");
}

/** One value as Markdown, on one line; "" when it has nothing to show. */
function leafText(field: FieldDefinition, value: Json | undefined, resolve: Resolve): string {
	if (value === null || value === undefined || value === "") return "";
	switch (field.type) {
		case "text":
		case "date":
			return typeof value === "string" ? escapeMarkdownLine(value) : "";
		case "number":
			return typeof value === "number" ? escapeMarkdownLine(String(value)) : "";
		case "richText":
			return typeof value === "string" ? escapeMarkdownLine(richTextToText(value)) : "";
		case "email":
			return typeof value === "string" ? markdownLink(value, `mailto:${value}`) : "";
		case "select": {
			const chosen = (Array.isArray(value) ? value : [value]).filter(isText);
			const labels = chosen.map((each) => field.options.find((option) => option.value === each)?.label ?? each);
			return escapeMarkdownLine(labels.join(", "));
		}
		case "link": {
			if (!isRecord(value) || typeof value.url !== "string" || value.url === "") return "";
			const text = typeof value.text === "string" && value.text !== "" ? value.text : value.url;
			return markdownLink(text, resolve.link(value.url));
		}
		case "media": {
			const file = typeof value === "string" ? resolve.media(value) : undefined;
			if (!file) return "";
			return file.image
				? `![${escapeMarkdownLine(file.alt ?? "")}](${markdownUrl(file.url)})`
				: markdownLink(file.alt || decodeURIComponent(file.url.split("/").pop() ?? ""), file.url);
		}
		case "relationship":
			return (Array.isArray(value) ? value : [value])
				.filter(isText)
				.flatMap((id) => {
					const found = resolve.entry(id);
					if (!found) return [];
					return [found.url ? markdownLink(found.title, found.url) : escapeMarkdownLine(found.title)];
				})
				.join(", ");
		default:
			return "";
	}
}

function isRecord(value: unknown): value is Record<string, Json> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}
