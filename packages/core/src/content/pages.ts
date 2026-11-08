import { entries, postTypes, publishedSlugs } from "@webcraft/db/schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import type { SiteScope, WorkspaceScope } from "../tenancy/data-layer.ts";
import { type ContentProblem, EntryInvalidError, PageParentUnpublishedError, PathTakenError } from "./errors.ts";
import { BUILT_IN_FIELDS } from "./fields.ts";
import { siteLanguages } from "./languages.ts";
import type { PostType } from "./post-types.ts";
import { bySpecificity, canonicalPath, ENTRY_SLUG, parseUrlPattern, slugIn, type UrlPattern } from "./url-patterns.ts";
import { type EntryVersion, readValue, storedVersion, type ValuePlace } from "./values.ts";

/**
 * Pages: the Entries of the built-in Page Post Type every Site has. A Page is arranged with a Page
 * layout rather than an Entry template, nests under a parent Page, and is found by its full path:
 * its parent's path and its own slug (`/about/team`). The home page is a Page too, at `/`.
 */

/** The Page Post Type as every Site gets it. */
export const PAGE_POST_TYPE = {
	key: "page",
	name: "Pages",
	/** Not a URL pattern Staff can write: each Page's path is its parent Page's path and its own slug. */
	urlPattern: "/{path}",
	builtIn: "page",
} as const;

/** The built-in Fields of a Page: every Entry's, and the parent Page it nests under (null at the top). */
export const PAGE_BUILT_IN_FIELDS = [...BUILT_IN_FIELDS, "parent"] as const;

/** Adds the Page Post Type to a new Site of the scope's Workspace, inside its transaction. */
export async function addPagePostType(scope: WorkspaceScope, siteId: string): Promise<void> {
	const now = scope.now();
	await scope.insert(postTypes, {
		siteId,
		key: PAGE_POST_TYPE.key,
		name: PAGE_POST_TYPE.name,
		urlPattern: PAGE_POST_TYPE.urlPattern,
		builtIn: PAGE_POST_TYPE.builtIn,
		createdAt: now,
		updatedAt: now,
	});
}

/** Whether a Post Type is the Page Post Type. */
export function isPagePostType(postType: { builtIn: string | null }): boolean {
	return postType.builtIn === PAGE_POST_TYPE.builtIn;
}

/** How deep Pages nest: a Page's path has at most this many parts. */
export const MAX_PAGE_DEPTH = 10;

/** Where a Page's parent is stored in each version: one value shared by every language. */
export function parentPlace(defaultLanguage: string): ValuePlace {
	return { key: "parent", translatable: false, language: defaultLanguage, defaultLanguage };
}

/** The parent Page a version names, or null for a top-level Page. */
export function parentIn(version: EntryVersion, defaultLanguage: string): string | null {
	return readValue(version, parentPlace(defaultLanguage));
}

/**
 * Checks a new parent for a Page's Draft, adding a problem when it can't be: it must be another Page
 * of the Site, not one of the Page's own child Pages (following each Page's Draft parent), and the
 * Page must not end up more than `MAX_PAGE_DEPTH` deep.
 */
export async function checkDraftParent(
	scope: Pick<SiteScope, "first">,
	page: { id: string; postTypeId: string },
	parentId: string,
	defaultLanguage: string,
	problems: ContentProblem[],
): Promise<void> {
	const problem = (message: string) => problems.push({ at: "parentId", message });
	if (parentId === page.id) return void problem("A Page can't be its own parent.");
	let current: string | null = parentId;
	for (let depth = 1; current !== null; depth++) {
		if (current === page.id) return void problem("A Page can't go under one of its own child Pages.");
		if (depth >= MAX_PAGE_DEPTH) return void problem(`Pages nest at most ${MAX_PAGE_DEPTH} deep.`);
		const row: { postTypeId: string; draft: unknown } | undefined = isUuid(current)
			? await scope.first(entries, eq(entries.id, current))
			: undefined;
		if (!row || row.postTypeId !== page.postTypeId) {
			return void problem(depth === 1 ? "There is no such Page on this Site." : "The Pages above this one are broken.");
		}
		current = parentIn(storedVersion(row.draft), defaultLanguage);
	}
}

/**
 * Whether another Page under the same parent has the slug, in its Draft or published, in a language:
 * Pages share a slug only under different parents.
 */
export async function pageSlugTaken(
	scope: Pick<SiteScope, "count">,
	page: { id: string; postTypeId: string },
	parentId: string | null,
	slug: { language: string; defaultLanguage: string; value: string },
): Promise<boolean> {
	const published = await scope.count(
		publishedSlugs,
		and(
			eq(publishedSlugs.postTypeId, page.postTypeId),
			eq(publishedSlugs.language, slug.language),
			parentId === null ? isNull(publishedSlugs.parentId) : eq(publishedSlugs.parentId, parentId),
			eq(publishedSlugs.slug, slug.value),
			ne(publishedSlugs.entryId, page.id),
		),
	);
	if (published > 0) return true;
	const drafts = await scope.count(
		entries,
		and(
			eq(entries.postTypeId, page.postTypeId),
			ne(entries.id, page.id),
			sql`${entries.draft} -> 'values' -> 'slug' -> ${slug.language}::text ->> 'value' = ${slug.value}`,
			sql`(${entries.draft} -> 'values' -> 'parent' -> ${slug.defaultLanguage}::text ->> 'value') is not distinct from ${parentId}::text`,
		),
	);
	return drafts > 0;
}

/** Each published Page's parent Page and slug, in one language: the Site's published Page tree. */
export type PageTree = Map<string, { parentId: string | null; slug: string }>;

/** The Site's published Pages, by id, with their parent and slug in `language`. */
export async function publishedPageTree(
	scope: Pick<SiteScope, "select">,
	pagesId: string,
	language: string,
): Promise<PageTree> {
	const rows = await scope.select(
		publishedSlugs,
		and(eq(publishedSlugs.postTypeId, pagesId), eq(publishedSlugs.language, language)),
	);
	return new Map(rows.map((row) => [row.entryId, { parentId: row.parentId, slug: row.slug }]));
}

/**
 * A Page's path in a tree, as its parts from the top (`["about", "team"]`), or undefined when a Page
 * above it isn't in the tree or the Pages loop.
 */
export function pathIn(tree: PageTree, pageId: string): string[] | undefined {
	const parts: string[] = [];
	const seen = new Set<string>();
	for (let current: string | null = pageId; current !== null; ) {
		const page = tree.get(current);
		if (!page || seen.has(current)) return undefined;
		seen.add(current);
		parts.unshift(page.slug);
		current = page.parentId;
	}
	return parts;
}

/** The Pages under a Page in a tree, at any depth. */
export function pagesUnder(tree: PageTree, pageId: string): string[] {
	const under: string[] = [];
	const visit = (parentId: string) => {
		for (const [id, page] of tree) {
			if (page.parentId === parentId && id !== pageId && !under.includes(id)) {
				under.push(id);
				visit(id);
			}
		}
	};
	visit(pageId);
	return under;
}

/**
 * Checks, as a Page is published, that the parent Page its Draft names is published and that the
 * Page isn't one of its own published ancestors: Pages nest only under published Pages, without loops.
 */
export function checkPublishedParent(tree: PageTree, pageId: string, parentId: string): void {
	const seen = new Set<string>();
	for (let current: string | null = parentId; current !== null; ) {
		if (current === pageId) {
			throw new EntryInvalidError([{ at: "parentId", message: "A Page can't go under one of its own child Pages." }]);
		}
		const page = tree.get(current);
		if (!page || seen.has(current)) throw new PageParentUnpublishedError();
		seen.add(current);
		current = page.parentId;
	}
}

/** The Post Type whose URL pattern owns a path (the most specific first), if any: Pages can't be there. */
export function patternOwning(postTypes: readonly PostType[], parts: readonly string[]): PostType | undefined {
	return postTypes
		.filter((postType) => !isPagePostType(postType))
		.map((postType) => ({ postType, pattern: parseUrlPattern(postType.urlPattern) }))
		.filter((candidate): candidate is { postType: PostType; pattern: UrlPattern } => !("problem" in candidate.pattern))
		.sort((a, b) => bySpecificity(a.pattern, b.pattern))
		.find(({ pattern }) => slugIn(pattern, parts) !== undefined)?.postType;
}

/** A path as visitors write it: `/about/team`, and `/` for no parts. */
export function pathText(parts: readonly string[]): string {
	return canonicalPath(parts);
}

/**
 * Refuses a URL pattern that would own the path of a published Page of the scope's Site
 * (`PathTakenError` naming the Page): Pages and Post Types never share a path.
 */
export async function checkPatternLeavesPages(
	scope: Pick<SiteScope, "select" | "first" | "db" | "site">,
	urlPattern: string,
): Promise<void> {
	const pattern = parseUrlPattern(urlPattern);
	if ("problem" in pattern) return;
	const pages = await scope.first(postTypes, eq(postTypes.builtIn, PAGE_POST_TYPE.builtIn));
	if (!pages) return;
	const { defaultLanguage } = await siteLanguages(scope);
	const tree = await publishedPageTree(scope, pages.id, defaultLanguage);
	for (const pageId of tree.keys()) {
		const parts = pathIn(tree, pageId);
		if (!parts || slugIn(pattern, parts) === undefined) continue;
		const row = await scope.first(entries, eq(entries.id, pageId));
		const title =
			readValue(storedVersion(row?.published), {
				key: "title",
				translatable: true,
				language: defaultLanguage,
				defaultLanguage,
			}) ?? "";
		throw new PathTakenError(pathText(parts), { kind: "page", id: pageId, title });
	}
}

/**
 * The published Page at a path, one part at a time: a top-level Page with the first part as its
 * slug, then the Page under it with the next, and so on. Undefined when there is none.
 */
export async function findPublishedPage(
	scope: Pick<SiteScope, "first">,
	pagesId: string,
	segments: readonly string[],
	language: string,
): Promise<string | undefined> {
	if (segments.length === 0 || segments.length > MAX_PAGE_DEPTH) return undefined;
	let parentId: string | null = null;
	for (const segment of segments) {
		if (!ENTRY_SLUG.test(segment)) return undefined;
		const row: { entryId: string } | undefined = await scope.first(
			publishedSlugs,
			and(
				eq(publishedSlugs.postTypeId, pagesId),
				eq(publishedSlugs.language, language),
				parentId === null ? isNull(publishedSlugs.parentId) : eq(publishedSlugs.parentId, parentId),
				eq(publishedSlugs.slug, segment),
			),
		);
		if (!row) return undefined;
		parentId = row.entryId;
	}
	return parentId ?? undefined;
}
