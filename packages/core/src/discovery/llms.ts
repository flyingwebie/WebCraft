import { entries } from "@webcraft/db/schema";
import { escapeMarkdownLine, markdownLink, textOf } from "@webcraft/renderer";
import { and, eq, isNotNull } from "drizzle-orm";

import { entryValues } from "../content/entries.ts";
import type { Languages } from "../content/field-values.ts";
import { languagePath, prefixOf, type SiteLanguage } from "../content/languages.ts";
import type { PostType } from "../content/post-types.ts";
import { resolvePath, valuesParts } from "../content/render-values.ts";
import { pathSegments } from "../content/url-patterns.ts";
import { type EntryVersion, storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import { placeOf } from "../domains/addresses.ts";
import { descriptionFrom } from "../seo/page-seo.ts";
import { siteSeoSettings } from "../seo/site-settings.ts";
import { type Listing, listedEntries, listedPostTypes } from "./listed.ts";

/**
 * `llms.txt` (spec story 118, after the llms.txt proposal): one per language, at the language's own
 * address (`/llms.txt` for the Default language, `/fr/llms.txt` under a prefix, `/llms.txt` on a
 * language's own domain). It names the Site (`# …`, the SEO settings' name for it, else its own),
 * says what it is (`> …`, its home page's description in the language, when it has one), then lists
 * each Post Type's listed Entries (`listed.ts`'s rule, the sitemaps' own), newest first, as
 * `- [Title](address of its Markdown copy): description`. A description is the page's own: its SEO
 * description, else its Summary, else the start of its Body field (cut at a word, as the page's
 * `<meta name="description">` is). Every text is escaped as Markdown.
 *
 * It lists at most `LLMS_ENTRIES_PER_POST_TYPE` Entries of each Post Type (the newest), so a big
 * Site's file stays short; the sitemaps list every one.
 */

/** The most Entries `llms.txt` lists for one Post Type: the newest. */
export const LLMS_ENTRIES_PER_POST_TYPE = 500;

/** The file name of `llms.txt`, at each language's root. */
export const LLMS_FILE = "llms.txt";

/** What a path asking for `llms.txt` answers: the file of a language, or its address elsewhere. */
export type LlmsAnswer = { kind: "file"; language: SiteLanguage } | { kind: "redirect"; location: string } | null;

/**
 * Which language's `llms.txt` a path asks for on a domain: `/llms.txt` is the domain's own language
 * (the Default language on the Primary domain, the language a language's domain serves), `/<prefix>/
 * llms.txt` a prefixed language's. One whose pages are on another of the Site's domains goes there
 * (301). Null for anything else.
 */
export function llmsAt(list: Listing, pathname: string): LlmsAnswer {
	const segments = pathSegments(pathname);
	if (!segments || segments.at(-1) !== LLMS_FILE || segments.length > 2) return null;
	const { site, host } = list;
	const [prefix] = segments.length === 2 ? segments : [];
	const language =
		prefix === undefined
			? site.languages.find(
					(candidate) =>
						candidate.code === (host.address === "language" && host.language ? host.language : site.defaultLanguage),
				)
			: site.languages.find(
					(candidate) => candidate.code !== site.defaultLanguage && prefixOf(candidate.code) === prefix,
				);
	if (!language) return null;
	const location = llmsAddress(list, language);
	if (location !== `${host.origin}${pathname}`) return { kind: "redirect", location };
	return { kind: "file", language };
}

/** Where a language's `llms.txt` is: at its root, on the domain its pages are on. */
function llmsAddress(list: Listing, language: SiteLanguage): string {
	const languages = { language: language.code, defaultLanguage: list.site.defaultLanguage };
	const there = placeOf(list.host.addresses, languages, languagePath(languages, "/"));
	return `${there.origin}${there.path === "/" ? "" : there.path}/${LLMS_FILE}`;
}

/** A language's `llms.txt`. */
export async function llmsText(list: Listing, language: SiteLanguage): Promise<string> {
	const languages = { language: language.code, defaultLanguage: list.site.defaultLanguage };
	const settings = await siteSeoSettings(list.scope);
	const lines = [`# ${escapeMarkdownLine(settings.siteName ?? list.host.site.name)}`, ""];
	const about = await homeDescription(list, languages);
	if (about) lines.push(`> ${about}`, "");
	for (const postType of await listedPostTypes(list)) {
		const items: string[] = [];
		for await (const entry of listedEntries(list, postType, { newest: true, limit: LLMS_ENTRIES_PER_POST_TYPE })) {
			const url = entry.urls.find((each) => each.language === language.code);
			if (!url || !entry.values) continue;
			const values = entryValues(entry.values, postType.fields, languages);
			const description = describe(postType, entry.values, languages);
			const link = markdownLink(values.title || postType.name, markdownCopyAddress(url.loc));
			items.push(description ? `- ${link}: ${escapeMarkdownLine(description)}` : `- ${link}`);
		}
		if (items.length > 0) lines.push(`## ${escapeMarkdownLine(postType.name)}`, "", ...items, "");
	}
	if (lines.at(-1) === "") lines.pop();
	return `${lines.join("\n")}\n`;
}

/**
 * An Entry's description, as its page's `<meta name="description">` gives it: its SEO description,
 * else its Post Type's Summary field, else the start of its Body field.
 */
export function describe(postType: PostType, version: EntryVersion, languages: Languages): string | null {
	const values = entryValues(version, postType.fields, languages);
	if (values.seo.description) return values.seo.description;
	const parts = valuesParts(postType.fields, values.fields);
	return descriptionFrom(postType, postType.seo, (path) => resolvePath(parts, path));
}

/** An Entry's Summary as plain text, in full: its Summary field's value; null without one. */
export function summaryOf(postType: PostType, version: EntryVersion, languages: Languages): string | null {
	if (!postType.summaryField) return null;
	const values = entryValues(version, postType.fields, languages);
	const parts = valuesParts(postType.fields, values.fields);
	const text = textOf(resolvePath(parts, postType.summaryField)).replace(/\s+/g, " ").trim();
	return text === "" ? null : text;
}

/** What the Site is, in a language: its home page's description there, while it is published and shown. */
async function homeDescription(list: Listing, languages: Languages): Promise<string | null> {
	if (!list.home) return null;
	const pages = list.postTypes.find((postType) => postType.builtIn === "page");
	const [row] = await list.scope.select(entries, and(eq(entries.id, list.home), isNotNull(entries.published)));
	if (!pages || !row) return null;
	const version = storedVersion(row.published);
	if (!isVisibleIn(version, languages)) return null;
	const description = describe(pages, version, languages);
	return description ? escapeMarkdownLine(description) : null;
}

/**
 * Where a page's Markdown copy is: its address plus `.md`; an address ending in `/` (a home page)
 * takes `index.html.md`, as the llms.txt proposal writes it.
 */
export function markdownCopyAddress(address: string): string {
	const url = new URL(address);
	url.pathname = url.pathname.endsWith("/") ? `${url.pathname}index.html.md` : `${url.pathname}.md`;
	return url.href;
}
