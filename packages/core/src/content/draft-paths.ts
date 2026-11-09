import { entries, publishedSlugs } from "@webcraft/db/schema";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";

import type { VisitorScope } from "../tenancy/data-layer.ts";
import type { PublishedAddress } from "./entry-paths.ts";
import { homePageId } from "./entry-paths.ts";
import type { Languages } from "./field-values.ts";
import { languagePath } from "./languages.ts";
import { isPagePostType, MAX_PAGE_DEPTH, type PageTree, pathIn, pathText } from "./pages.ts";
import type { PostType } from "./post-types.ts";
import { ENTRY_SLUG, pathFor } from "./url-patterns.ts";

/**
 * Where Entries are on a Site's Staging address (ADR 0014), which shows the Site as it would be with
 * every Draft published: an Entry's Draft address is its URL pattern with the slug publishing its
 * Draft would give it in the language (its own there; else, outside the Default language, the slug it
 * was published with there before, else the Default language's), and a Page's is its Draft parents'
 * paths and its slug. Entries never published have one too, so they can be reviewed before they go
 * live. The same rules as `publishedSlug` in `publishing.ts`, worked out in SQL to find an Entry by
 * its address with one query.
 */

type Reader = Pick<VisitorScope, "select" | "first" | "where" | "db">;

/** The slug an Entry's Draft would be published with in the language, as SQL on an `entries` row. */
function draftSlugSql(languages: Languages): SQL<string | null> {
	const own = sql`nullif(${entries.draft} -> 'values' -> 'slug' -> ${languages.language}::text ->> 'value', '')`;
	if (languages.language === languages.defaultLanguage) return sql<string | null>`${own}`;
	const kept = sql`(select ${publishedSlugs.slug} from ${publishedSlugs} where ${publishedSlugs.siteId} = ${entries.siteId} and ${publishedSlugs.entryId} = ${entries.id} and ${publishedSlugs.language} = ${languages.language})`;
	const fallback = sql`nullif(${entries.draft} -> 'values' -> 'slug' -> ${languages.defaultLanguage}::text ->> 'value', '')`;
	return sql<string | null>`coalesce(${own}, ${kept}, ${fallback})`;
}

/** Whether an Entry's Draft is shown in the language (not hidden there), as SQL on an `entries` row. */
export function draftVisibleIn(languages: Languages): SQL {
	return sql`not coalesce((${entries.draft} -> 'values' -> 'hiddenLanguages' -> ${languages.defaultLanguage}::text -> 'value') @> jsonb_build_array(${languages.language}::text), false)`;
}

/** A Page's parent in its Draft (kept under the Default language), as SQL on an `entries` row. */
function draftParentSql(languages: Languages): SQL<string | null> {
	return sql<
		string | null
	>`(${entries.draft} -> 'values' -> 'parent' -> ${languages.defaultLanguage}::text ->> 'value')`;
}

/** The Entry of a Post Type whose Draft would be published at `slug` in the language, shown there. */
export async function findDraftEntry(
	scope: Reader,
	postTypeId: string,
	slug: string,
	languages: Languages,
): Promise<typeof entries.$inferSelect | undefined> {
	const [row] = await scope.db
		.select()
		.from(entries)
		.where(
			scope.where(
				entries,
				and(eq(entries.postTypeId, postTypeId), sql`${draftSlugSql(languages)} = ${slug}`, draftVisibleIn(languages)),
			),
		)
		.orderBy(entries.createdAt)
		.limit(1);
	return row;
}

/**
 * The Page whose Draft would be published at the path's parts in the language: walked one part at a
 * time, each a Page whose Draft parent is the one before.
 */
export async function findDraftPage(
	scope: Reader,
	pagesId: string,
	segments: readonly string[],
	languages: Languages,
): Promise<string | undefined> {
	if (segments.length === 0 || segments.length > MAX_PAGE_DEPTH) return undefined;
	let parentId: string | null = null;
	for (const segment of segments) {
		if (!ENTRY_SLUG.test(segment)) return undefined;
		const parent: SQL =
			parentId === null ? sql`${draftParentSql(languages)} is null` : sql`${draftParentSql(languages)} = ${parentId}`;
		const [row]: { id: string }[] = await scope.db
			.select({ id: entries.id })
			.from(entries)
			.where(
				scope.where(
					entries,
					and(eq(entries.postTypeId, pagesId), parent, sql`${draftSlugSql(languages)} = ${segment}`),
				),
			)
			.orderBy(entries.createdAt)
			.limit(1);
		if (!row) return undefined;
		parentId = row.id;
	}
	return parentId ?? undefined;
}

/** Every Page's Draft parent and Draft slug in the language: the Page tree as it would be published. */
async function draftPageTree(scope: Reader, pagesId: string, languages: Languages): Promise<PageTree> {
	const rows = await scope.db
		.select({ id: entries.id, parentId: draftParentSql(languages), slug: draftSlugSql(languages) })
		.from(entries)
		.where(scope.where(entries, eq(entries.postTypeId, pagesId)));
	return new Map(rows.map((row) => [row.id, { parentId: row.parentId ?? null, slug: row.slug ?? "" }]));
}

/**
 * Where each of these Entries of one Post Type would be once its Draft is published, in the language,
 * by id: its URL pattern with its Draft slug, or a Page's Draft parents and slug (the home page at
 * `/`), under the language's prefix. An Entry without a slug has none.
 */
export async function draftAddresses(
	scope: Reader,
	postType: Pick<PostType, "id" | "builtIn" | "urlPattern">,
	entryIds: readonly string[],
	languages: Languages,
): Promise<Map<string, PublishedAddress>> {
	const found = new Map<string, PublishedAddress>();
	if (entryIds.length === 0) return found;
	if (isPagePostType(postType)) {
		const tree = await draftPageTree(scope, postType.id, languages);
		const home = await homePageId(scope);
		for (const id of entryIds) {
			const page = tree.get(id);
			const parts = pathIn(tree, id);
			if (!page || !parts || parts.some((part) => part === "")) continue;
			found.set(id, { slug: page.slug, path: languagePath(languages, id === home ? "/" : pathText(parts)) });
		}
		return found;
	}
	const rows = await scope.db
		.select({ id: entries.id, slug: draftSlugSql(languages) })
		.from(entries)
		.where(scope.where(entries, and(eq(entries.postTypeId, postType.id), inArray(entries.id, [...entryIds]))));
	for (const row of rows) {
		const path = row.slug ? pathFor(postType.urlPattern, row.slug) : null;
		if (row.slug && path) found.set(row.id, { slug: row.slug, path: languagePath(languages, path) });
	}
	return found;
}
