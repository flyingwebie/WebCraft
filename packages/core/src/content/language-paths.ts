import { entries, postTypes as postTypeRows, publishedSlugs } from "@webcraft/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { PathTakenError } from "./errors.ts";
import { type SiteLanguage, type SiteLanguages, siteLanguages } from "./languages.ts";
import { isPagePostType, PAGE_POST_TYPE } from "./pages.ts";
import { listPostTypes } from "./post-types.ts";
import { parseUrlPattern, pathFor } from "./url-patterns.ts";
import { ownValue, storedVersion } from "./values.ts";

/**
 * Language prefixes and the Site's other paths. Every language but the Default language owns every
 * path under its prefix (`/fr/…`), so no Default language path (a top-level Page, an Entry under a
 * URL pattern starting with `{slug}`, a URL pattern starting with a fixed part) may start with one.
 * Each check runs while the Site's paths are held (`lockSitePaths`).
 */

/** The language other than the Default language whose prefix starts a Default language path, if any. */
export function languageOwning(site: SiteLanguages, parts: readonly string[]): SiteLanguage | undefined {
	const [first] = parts;
	return first === undefined ? undefined : site.languages.find((language) => language.prefix === first);
}

/** Refuses a Default language path a language's prefix owns (`PathTakenError` naming the language). */
export function checkPathOutsidePrefixes(site: SiteLanguages, parts: readonly string[], path: string): void {
	const language = languageOwning(site, parts);
	if (language) throw new PathTakenError(path, { kind: "language", code: language.code, name: language.name });
}

/**
 * Refuses a URL pattern whose first part is a language's prefix, and, for a Post Type's pattern
 * starting with `{slug}`, a published Entry whose slug is one.
 */
export async function checkPatternOutsidePrefixes(
	scope: Pick<SiteScope, "db" | "site" | "select">,
	urlPattern: string,
	postTypeId?: string,
): Promise<void> {
	const pattern = parseUrlPattern(urlPattern);
	if ("problem" in pattern) return;
	const site = await siteLanguages(scope);
	const [first] = pattern.segments;
	if (first?.kind === "fixed") {
		checkPathOutsidePrefixes(site, [first.text], `/${first.text}`);
		return;
	}
	if (postTypeId === undefined) return;
	const prefixes = prefixesOf(site);
	if (prefixes.length === 0) return;
	const [taken] = await scope.select(
		publishedSlugs,
		and(
			eq(publishedSlugs.postTypeId, postTypeId),
			eq(publishedSlugs.language, site.defaultLanguage),
			inArray(publishedSlugs.slug, prefixes),
		),
	);
	if (taken) checkPathOutsidePrefixes(site, [taken.slug], pathFor(urlPattern, taken.slug) ?? `/${taken.slug}`);
}

/**
 * Refuses a new prefix the Site's Default language paths already start with: a published top-level
 * Page with that slug, a URL pattern starting with it, or a published Entry whose path does (a
 * pattern starting with `{slug}`). Answers `PathTakenError` naming what holds the path.
 */
export async function checkPrefixFree(scope: SiteScope, prefix: string): Promise<void> {
	const { defaultLanguage } = await siteLanguages(scope);
	const path = `/${prefix}`;
	for (const postType of await listPostTypes(scope)) {
		if (isPagePostType(postType)) continue;
		const pattern = parseUrlPattern(postType.urlPattern);
		if ("problem" in pattern) continue;
		const [first] = pattern.segments;
		const holder = { kind: "postType", id: postType.id, name: postType.name, urlPattern: postType.urlPattern } as const;
		if (first?.kind === "fixed" && first.text === prefix) throw new PathTakenError(path, holder);
		if (first?.kind !== "slug") continue;
		const taken = await scope.first(
			publishedSlugs,
			and(
				eq(publishedSlugs.postTypeId, postType.id),
				eq(publishedSlugs.language, defaultLanguage),
				eq(publishedSlugs.slug, prefix),
			),
		);
		if (taken) throw new PathTakenError(pathFor(postType.urlPattern, prefix) ?? path, holder);
	}
	const pages = await scope.first(postTypeRows, eq(postTypeRows.builtIn, PAGE_POST_TYPE.builtIn));
	if (!pages) return;
	const page = await scope.first(
		publishedSlugs,
		and(
			eq(publishedSlugs.postTypeId, pages.id),
			eq(publishedSlugs.language, defaultLanguage),
			isNull(publishedSlugs.parentId),
			eq(publishedSlugs.slug, prefix),
		),
	);
	if (!page) return;
	const row = await scope.first(entries, eq(entries.id, page.entryId));
	const published = storedVersion(row?.published);
	const title = ownValue(published, "title", defaultLanguage) ?? "";
	throw new PathTakenError(path, { kind: "page", id: page.entryId, title });
}

/** The prefixes of the Site's languages other than the Default language. */
function prefixesOf(site: SiteLanguages): string[] {
	return site.languages.flatMap((language) => (language.prefix === null ? [] : [language.prefix]));
}

/**
 * Gives every published Entry of the scope's Site its published slug in a language just added, so it
 * answers there at once: the language's own slug in its published version when it has one (a
 * language removed and added again), else the Default language's published slug. Should an own slug
 * clash with another Entry's, the Default language's is used, then the first of `-2`, `-3`, … that
 * is free.
 */
export async function publishSlugsIn(scope: SiteScope, language: string, defaultLanguage: string): Promise<void> {
	const rows = await scope.select(publishedSlugs, eq(publishedSlugs.language, defaultLanguage));
	if (rows.length === 0) return;
	const published = await scope.select(
		entries,
		inArray(
			entries.id,
			rows.map((row) => row.entryId),
		),
	);
	const versions = new Map(published.map((row) => [row.id, storedVersion(row.published)]));
	const candidates = rows.map((row) => {
		const version = versions.get(row.entryId);
		return { row, own: version ? ownValue(version, "slug", language) : null };
	});
	// Slugs taken in the Default language claim theirs first, so only a language's own slugs can clash.
	candidates.sort((a, b) => Number(a.own !== null) - Number(b.own !== null));
	const taken = new Set<string>();
	const keyOf = (row: (typeof rows)[number], slug: string) => `${row.postTypeId} ${row.parentId ?? ""} ${slug}`;
	for (const { row, own } of candidates) {
		let slug = own ?? row.slug;
		if (taken.has(keyOf(row, slug))) slug = row.slug;
		for (let attempt = 2; taken.has(keyOf(row, slug)); attempt++) slug = `${row.slug}-${attempt}`;
		taken.add(keyOf(row, slug));
		await scope.insert(publishedSlugs, {
			entryId: row.entryId,
			postTypeId: row.postTypeId,
			language,
			slug,
			parentId: row.parentId,
		});
	}
}
