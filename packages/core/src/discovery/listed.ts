import { entries, publishedSlugs, specialPages, templates } from "@webcraft/db/schema";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, max, type SQL } from "drizzle-orm";

import { publishedArchives } from "../content/archives.ts";
import { homePageId } from "../content/entry-paths.ts";
import type { Languages } from "../content/field-values.ts";
import { languagePath, type SiteLanguage, type SiteLanguages, siteLanguages } from "../content/languages.ts";
import { isPagePostType, type PageTree, pathIn, pathText, publishedPageTree } from "../content/pages.ts";
import { listPostTypes, type PostType } from "../content/post-types.ts";
import { pathFor } from "../content/url-patterns.ts";
import { type EntryVersion, storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import { placeOf } from "../domains/addresses.ts";
import { publishedIndexable, readEntrySeo } from "../seo/entry-seo.ts";
import { canonicalOf } from "../seo/page-seo.ts";
import type { SiteHost } from "../site-pages/index.ts";
import type { VisitorScope } from "../tenancy/data-layer.ts";

/**
 * Which pages a Site lists in its discovery files (sitemaps and llms.txt; spec stories 112, 117,
 * 118), on one of its domains. One rule for both, so they never disagree:
 *
 * - **Pages visitors can reach**: published Entries of a Post Type whose Entries have pages (the Page
 *   Post Type, or one with a published Entry template), at their published address in each language
 *   on this domain (the Default language and prefixed languages on the Primary domain; a language's
 *   own domain, that language), and each Post Type's Archive page while its Archive template is
 *   published (its first page only).
 * - **Left out**: noindex Entries (`publishedIndexable`), an Entry in a language it is hidden in
 *   (`isVisibleIn`), Drafts, an Entry whose canonical URL is elsewhere in that language, the Site's 404
 *   pages and its search results page (never indexed), paths a Redirect rule sends elsewhere, and
 *   Post Types Staff leave out. Filtered, sorted, searched and paginated pages are never listed: only
 *   each page's own address is.
 *
 * Each address lists its `hreflang` alternates as its page's head does: every language the Entry is
 * shown in, at that language's address (on this domain or another of the Site's), then `x-default` at
 * the Default language's; none on a Site with one language.
 *
 * Entries are read a batch at a time in a stable order (by id, or newest first), so a big Site is
 * never read in one query.
 */

/** How many Entries one query reads. */
export const LISTING_BATCH = 500;

/** What listing a domain's pages reads once per request. */
export type Listing = {
	scope: VisitorScope;
	host: SiteHost;
	site: SiteLanguages;
	/** The Site's languages whose pages are on this domain, in the Site's order. */
	here: SiteLanguage[];
	postTypes: PostType[];
	/** Pages never listed: the Site's 404 pages (its own and each language's) and its search results page. */
	unlisted: Set<string>;
	home: string | undefined;
	/** Each language's published Page tree, read once when Pages are listed. */
	trees: Map<string, Promise<PageTree>>;
	/**
	 * The Site paths among these a Redirect rule sends elsewhere ahead of its pages (by the Site path,
	 * every language but the Default one under its prefix), so they aren't listed.
	 */
	redirected(paths: readonly string[]): Promise<Set<string>>;
};

/** An address a domain lists: its page in one language, when it last changed and its alternates. */
export type ListedUrl = {
	/** The page's absolute address on this domain. */
	loc: string;
	/** Its path as the Site writes it (under its language's prefix). */
	sitePath: string;
	language: string;
	lastmod: Date | null;
	/** `hreflang` and absolute address, as the page's head lists them (`x-default` last). */
	alternates: { hreflang: string; href: string }[];
};

/** A listed Entry (or Archive page, with an empty id) and its addresses on the domain. */
export type ListedEntry = { id: string; postType: PostType; values: EntryVersion | null; urls: ListedUrl[] };

/** Reads what listing a domain's pages needs. */
export async function listing(
	scope: VisitorScope,
	host: SiteHost,
	redirected: Listing["redirected"],
): Promise<Listing> {
	const site = await siteLanguages(scope);
	const here = site.languages.filter((language) => originOf(host, site, language.code) === host.origin);
	const special = await scope.select(specialPages, inArray(specialPages.role, ["notFound", "search"]));
	return {
		scope,
		host,
		site,
		here,
		postTypes: await listPostTypes(scope),
		unlisted: new Set(special.map((row) => row.entryId)),
		home: await homePageId(scope),
		trees: new Map(),
		redirected,
	};
}

/** Where a language's pages are: the origin of its root. */
function originOf(host: SiteHost, site: SiteLanguages, language: string): string {
	return placeOf(host.addresses, { language, defaultLanguage: site.defaultLanguage }, "/").origin;
}

/**
 * The Post Types whose Entries have pages and that Staff haven't left out of the Site's discovery
 * files (`sitemap`), in the order they list them: Pages first, then the rest by name.
 */
export async function listedPostTypes(list: Listing): Promise<PostType[]> {
	const rendered = new Set(
		(await list.scope.select(templates, and(eq(templates.kind, "entry"), isNotNull(templates.published)))).map(
			(row) => row.postTypeId,
		),
	);
	return list.postTypes
		.filter((postType) => postType.sitemap && (isPagePostType(postType) || rendered.has(postType.id)))
		.sort((a, b) => Number(isPagePostType(b)) - Number(isPagePostType(a)) || a.name.localeCompare(b.name));
}

/**
 * Every listed Entry of a Post Type with its addresses on the domain, a batch at a time: by id from
 * the Entry `from` (inclusive; from the start without it, its Archive page first as the empty id),
 * or newest first (`newest`, at most `limit`, no Archive page).
 */
export async function* listedEntries(
	list: Listing,
	postType: PostType,
	options: { from?: string; newest?: boolean; limit?: number } = {},
): AsyncGenerator<ListedEntry> {
	if (list.here.length === 0) return;
	if (!options.from && !options.newest) {
		const archive = await archiveEntry(list, postType);
		if (archive) yield archive;
	}
	let after = "";
	let first = options.newest ? "" : (options.from ?? "");
	let offset = 0;
	let left = options.limit ?? Number.POSITIVE_INFINITY;
	while (left > 0) {
		const size = Math.min(LISTING_BATCH, left);
		const conditions: (SQL | undefined)[] = [
			eq(entries.postTypeId, postType.id),
			isNotNull(entries.published),
			publishedIndexable(list.site),
			first !== "" ? gte(entries.id, first) : after !== "" && !options.newest ? gt(entries.id, after) : undefined,
		];
		const query = list.scope.db
			.select({ id: entries.id, published: entries.published, lastPublishedAt: entries.lastPublishedAt })
			.from(entries)
			.where(list.scope.where(entries, and(...conditions)))
			.limit(size);
		const rows = options.newest
			? await query.orderBy(desc(entries.lastPublishedAt), asc(entries.id)).offset(offset)
			: await query.orderBy(asc(entries.id));
		if (rows.length === 0) return;
		const listed = await listBatch(list, postType, rows);
		for (const entry of listed) yield entry;
		if (rows.length < size) return;
		after = rows.at(-1)?.id ?? after;
		first = "";
		offset += rows.length;
		left -= rows.length;
	}
}

/** One batch of published, indexable Entries of a Post Type, with their addresses on the domain. */
async function listBatch(
	list: Listing,
	postType: PostType,
	rows: { id: string; published: unknown; lastPublishedAt: Date | null }[],
): Promise<ListedEntry[]> {
	const { site } = list;
	const addresses = await addressesOf(
		list,
		postType,
		rows.map((row) => row.id),
	);
	const found: ListedEntry[] = [];
	const candidates: ListedEntry[] = [];
	for (const row of rows) {
		const version = storedVersion(row.published);
		// Where the Entry is shown, in the Site's languages' order: its page's `hreflang` alternates.
		const shown: { language: string; path: string; href: string }[] = [];
		for (const language of site.languages) {
			const languages = { language: language.code, defaultLanguage: site.defaultLanguage };
			const path = addresses.get(language.code)?.get(row.id);
			if (path === undefined || !isVisibleIn(version, languages)) continue;
			shown.push({ language: language.code, path, href: hrefOf(list.host, languages, path) });
		}
		const alternates = alternatesOf(site, shown);
		const urls: ListedUrl[] = [];
		if (!list.unlisted.has(row.id)) {
			for (const place of shown) {
				if (!list.here.some((language) => language.code === place.language)) continue;
				const languages = { language: place.language, defaultLanguage: site.defaultLanguage };
				// An Entry pointing search engines at another address isn't listed in that language.
				const canonical = readEntrySeo(version.values, languages).canonical;
				if (canonical && canonicalOf({ addresses: list.host.addresses, languages: site }, canonical) !== place.href) {
					continue;
				}
				urls.push({
					loc: place.href,
					sitePath: place.path,
					language: place.language,
					lastmod: row.lastPublishedAt,
					alternates,
				});
			}
		}
		candidates.push({ id: row.id, postType, values: version, urls });
	}
	const redirected = await list.redirected(candidates.flatMap((entry) => entry.urls.map((url) => url.sitePath)));
	for (const entry of candidates) {
		const urls = entry.urls.filter((url) => !redirected.has(url.sitePath));
		if (urls.length > 0) found.push({ ...entry, urls });
	}
	return found;
}

/** Each language's published paths of these Entries of a Post Type, under the language's prefix. */
async function addressesOf(
	list: Listing,
	postType: PostType,
	ids: readonly string[],
): Promise<Map<string, Map<string, string>>> {
	const { site } = list;
	const byLanguage = new Map<string, Map<string, string>>();
	for (const language of site.languages) byLanguage.set(language.code, new Map());
	if (isPagePostType(postType)) {
		for (const language of site.languages) {
			let tree = list.trees.get(language.code);
			if (!tree) {
				tree = publishedPageTree(list.scope, postType.id, language.code);
				list.trees.set(language.code, tree);
			}
			const pages = await tree;
			const languages = { language: language.code, defaultLanguage: site.defaultLanguage };
			for (const id of ids) {
				const parts = pathIn(pages, id);
				if (!parts) continue;
				byLanguage.get(language.code)?.set(id, languagePath(languages, id === list.home ? "/" : pathText(parts)));
			}
		}
		return byLanguage;
	}
	const rows = await list.scope.select(
		publishedSlugs,
		and(eq(publishedSlugs.postTypeId, postType.id), inArray(publishedSlugs.entryId, [...ids])),
	);
	for (const row of rows) {
		const path = pathFor(postType.urlPattern, row.slug);
		const languages = { language: row.language, defaultLanguage: site.defaultLanguage };
		if (path) byLanguage.get(row.language)?.set(row.entryId, languagePath(languages, path));
	}
	return byLanguage;
}

/**
 * A Post Type's Archive page while its Archive template is published: shown in every language, last
 * changed when its template was published or one of its listed Entries was, whichever came later.
 */
async function archiveEntry(list: Listing, postType: PostType): Promise<ListedEntry | undefined> {
	const archive = (await publishedArchives(list.scope, [postType]))[0];
	if (!archive) return undefined;
	const { site } = list;
	const [template] = await list.scope.select(
		templates,
		and(eq(templates.kind, "archive"), eq(templates.postTypeId, postType.id)),
	);
	const [newest] = await list.scope.db
		.select({ at: max(entries.lastPublishedAt) })
		.from(entries)
		.where(
			list.scope.where(
				entries,
				and(eq(entries.postTypeId, postType.id), isNotNull(entries.published), publishedIndexable(site)),
			),
		);
	const changed = [template?.lastPublishedAt, newest?.at].filter((at): at is Date => at instanceof Date);
	const lastmod = changed.length === 0 ? null : new Date(Math.max(...changed.map((at) => at.getTime())));
	const shown = site.languages.map((language) => {
		const languages = { language: language.code, defaultLanguage: site.defaultLanguage };
		const path = languagePath(languages, pathText(archive.parts));
		return { language: language.code, path, href: hrefOf(list.host, languages, path) };
	});
	const alternates = alternatesOf(site, shown);
	const urls = shown
		.filter((place) => list.here.some((language) => language.code === place.language))
		.map((place) => ({ loc: place.href, sitePath: place.path, language: place.language, lastmod, alternates }));
	const redirected = await list.redirected(urls.map((url) => url.sitePath));
	const kept = urls.filter((url) => !redirected.has(url.sitePath));
	return kept.length > 0 ? { id: "", postType, values: null, urls: kept } : undefined;
}

/** A page's absolute address for visitors: its path in its language where the language's pages are. */
function hrefOf(host: SiteHost, languages: Languages, path: string): string {
	const there = placeOf(host.addresses, languages, path);
	return `${there.origin}${there.path}`;
}

/** A page's `hreflang` alternates, as its head lists them: none on a Site with one language. */
function alternatesOf(
	site: SiteLanguages,
	shown: readonly { language: string; href: string }[],
): { hreflang: string; href: string }[] {
	if (site.languages.length < 2) return [];
	const alternates = shown.map((place) => ({ hreflang: place.language, href: place.href }));
	const fallback = shown.find((place) => place.language === site.defaultLanguage);
	if (fallback) alternates.push({ hreflang: "x-default", href: fallback.href });
	return alternates;
}
